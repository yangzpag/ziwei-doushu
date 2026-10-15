/**
 * 课程问答 Agent —— 基于 LangChain（createAgent + tool calling）。
 *
 * 工作方式（loop）：模型自主决定是否调用检索工具、用什么关键词；
 * 检索结果作为工具返回值喂回模型；佐证段落通过工具闭包累计。
 * 每轮工具调用通过 trace 事件透出（用户可见 agent 决策过程）。
 *
 * 流程：
 *   1. LangChain agent 循环（search_course_segments 工具可多轮调用）
 *   2. 佐证池非空 → 写手阶段：基于段落流式生成带引用回答（主角是回答）
 *      佐证池为空 → 通用直答兜底
 *   3. agent 运行失败（端点不支持 tools 等）→ 回退规则路由，不赌单点
 */
import Anthropic from '@anthropic-ai/sdk';
import { createAgent } from 'langchain';
import { ChatAnthropic } from '@langchain/anthropic';
import { tool } from '@langchain/core/tools';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { searchSegments } from './search';
import { courseName, formatSeconds, jumpUrl } from './courses';
import { routeQuery, isNoHit, type HistoryTurn } from './router';
import type { SegmentHit } from './search';

/** 佐证段落（附编号、跳转入口；text 供回答引用与佐证展开） */
export interface SegmentOut {
  n: number;
  segment_id: string;
  title: string;
  course: string;
  time_range: string;
  jump_url: string;
  text_preview: string;
  text: string;
  score: number;
}

/** 统一出口：JSON 模式累积、SSE 模式转发 */
export interface Emitter {
  route(r: { decision: string; score: number; reason: string }): void;
  delta(text: string): void;
  note(text: string): void;
  segments(segs: SegmentOut[]): void;
  /** agent 思考/行动轨迹（loop 可见性） */
  trace(text: string): void;
}

interface NormSeg {
  title: string;
  course: string;
  time_range: string;
  text: string;
}

export function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    timeout: 20_000,
    maxRetries: 0,
  });
}

function extractText(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** 写手阶段：流式生成（AI 可用时逐字转发；不可用/失败返回 null，调用方降级） */
export async function streamAnswer(
  system: string,
  user: string,
  maxTokens: number,
  em: Emitter
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const stream = client.messages.stream(
      {
        model: process.env.AI_MODEL || 'deepseek-chat',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { timeout: 30_000 }
    );
    let full = '';
    stream.on('text', (t) => {
      full += t;
      em.delta(t);
    });
    const final = await stream.finalMessage();
    const text = extractText(final);
    return text || (full.trim() ? full.trim() : null);
  } catch {
    return null;
  }
}

/** 带引用的回答：只依据给定段落，论点挂 [编号] */
async function answerWithCitations(q: string, segments: NormSeg[], em: Emitter): Promise<string | null> {
  if (!segments.length) return null;
  const passageList = segments
    .map((s, i) => `[${i + 1}] 《${s.title}》（${s.course}，${s.time_range}）\n${s.text}`)
    .join('\n\n');
  return streamAnswer(
    `你是倪海厦《人纪》课程学习助手。规则：
1. 只依据下方给出的课程段落回答，禁止使用段落之外的知识；
2. 每个论点后用 [编号] 标注依据哪个段落，没有依据的内容不要写；
3. 课程内容是讲者观点，不是已证实结论，不要绝对化表述；
4. 段落没讲到的，直接说「课程里没讲这个」；
5. 简体中文，分点组织，300-500 字。`,
    `问题：${q}\n\n课程段落：\n${passageList}`,
    800,
    em
  );
}

/** 直接回答（不查库）：通用问题/闲聊 */
async function answerDirect(q: string, em: Emitter): Promise<string | null> {
  return streamAnswer(
    `你是一个友好的助手。用户的问题与中医课程库无关，直接简洁回答即可。
如果问题涉及紫微斗数排盘，提示用户使用本站的排盘功能。简体中文，200 字以内。`,
    q,
    500,
    em
  );
}

function toSegmentOut(segments: SegmentHit[]): SegmentOut[] {
  return segments.map((s, i) => ({
    n: i + 1,
    segment_id: s.segment_id,
    title: s.title,
    course: courseName(s.course_id),
    time_range: `${formatSeconds(s.start_seconds)}–${formatSeconds(s.end_seconds, 'round')}`,
    jump_url: jumpUrl(s.bvid, s.start_seconds),
    text_preview: s.text.slice(0, 120),
    text: s.text.slice(0, 600),
    score: Number(s.score.toFixed(3)),
  }));
}

/** 追问素材：历史上最近一轮带佐证的 assistant 消息（按原顺序重编号） */
export function collectContextSegments(history: HistoryTurn[]): SegmentOut[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const segs = h.segmentsOut as unknown as SegmentOut[] | undefined;
    if (h.role === 'assistant' && Array.isArray(segs) && segs.length) {
      return segs.map((s, idx) => ({ ...s, n: idx + 1 }));
    }
  }
  return [];
}

const DIRECT_FALLBACK = '这个问题与课程库无关。当前网络暂时无法调用 AI 通用回答，你可以换个课程相关的问题（药名、方剂、症状、条文）试试。';
const NOHIT_FALLBACK = '课程库里没有找到与这个问题相关的内容。当前网络暂时无法调用 AI 通用回答。';

/** 段落池去重并入（按 segment_id，重编号） */
function mergePool(pool: SegmentOut[], incoming: SegmentOut[]): SegmentOut[] {
  const seen = new Set(pool.map((s) => s.segment_id));
  const merged = [...pool];
  for (const s of incoming) {
    if (seen.has(s.segment_id)) continue;
    seen.add(s.segment_id);
    merged.push(s);
  }
  return merged.map((s, i) => ({ ...s, n: i + 1 }));
}

/**
 * Agent 主流程：LangChain 工具循环（收集佐证）→ 写手阶段（流式带引用回答）。
 * agent 运行失败 → 回退规则路由（routeQuery），行为不劣化。
 */
export async function runAgent(
  q: string,
  course: string | undefined,
  history: HistoryTurn[],
  em: Emitter
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const pool: SegmentOut[] = [];
  const seen = new Set<string>();
  let rounds = 0;

  // 检索工具：模型自主决定调不调、用什么关键词；结果累计进佐证池
  // 轮数上限在工具内强制：达到上限后返回提示，模型只能基于现有段落回答
  const searchTool = tool(
    async ({ query }) => {
      rounds += 1;
      em.trace(`🔍 检索（第 ${rounds} 轮）：${query}`);
      if (rounds > 3) {
        em.trace('🛑 已达检索上限（3 轮），基于已收集段落作答');
        return '已达检索轮数上限（3 轮）。请基于已收集的段落直接给出结论，不要再检索。';
      }
      const hits = await searchSegments(query, { databaseUrl, courseId: course, limit: 5 });
      if (!hits.length) {
        em.trace('👀 没有命中任何段落');
        return '没有命中任何课程段落。可以换个关键词再试，或放弃检索直接回答。';
      }
      const outs = toSegmentOut(hits);
      let added = 0;
      for (const o of outs) {
        if (!seen.has(o.segment_id)) {
          seen.add(o.segment_id);
          pool.push(o);
          added += 1;
        }
      }
      em.trace(`👀 命中 ${hits.length} 段，新增 ${added} 段：${hits.slice(0, 3).map((h) => `《${h.title}》`).join(' ')}${hits.length > 3 ? ' …' : ''}`);
      // 工具返回带编号的段落文本，模型后续引用时用这些编号
      return outs
        .map((o) => {
          const n = pool.findIndex((p) => p.segment_id === o.segment_id) + 1;
          return `[${n}] 《${o.title}》（${o.course}，${o.time_range}）\n${o.text}`;
        })
        .join('\n\n');
    },
    {
      name: 'search_course_segments',
      description:
        '检索倪海厦《人纪》课程（伤寒论/金匮要略/神农本草经/黄帝内经/仲景心法/针灸大成）的语义段落。输入检索关键词（药材名、方剂名、症状、条文号等）。',
      schema: z.object({
        query: z.string().min(1).describe('检索关键词，如：半夏、条336、湿疹'),
      }),
    }
  );

  // 组装消息历史（供模型理解上下文）
  const msgs: (HumanMessage | AIMessage)[] = [];
  for (const h of history.slice(-4)) {
    msgs.push(h.role === 'user' ? new HumanMessage(h.text) : new AIMessage(h.text));
  }
  msgs.push(new HumanMessage(q));

  // ── LangChain agent 循环（收集佐证） ──
  const model = new ChatAnthropic({
    model: process.env.AI_MODEL || 'deepseek-chat',
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(process.env.ANTHROPIC_BASE_URL ? { anthropicApiUrl: process.env.ANTHROPIC_BASE_URL } : {}),
    maxRetries: 0,
    clientOptions: { timeout: 60_000 },
    streaming: false,
  });

  // 上下文已有段落清单（喂给 agent，让它知道追问的实体是否已检索过）
  const ctxTitles = collectContextSegments(history).map((s) => s.title);

  const agent = createAgent({
    model,
    tools: [searchTool],
    systemPrompt: `你是中医课程问答 agent，负责为回答收集佐证段落。规则：
1. 问题涉及课程内容（药、方、条文、症状、讲法）→ 调用检索工具；第一轮关键词贴合问题，后续轮次换角度（相关药材/方剂/症状术语）
2. 上下文对话中已检索过的段落足够回答追问（注意「上下文已有段落」清单）→ 不调工具，直接结束
3. 与课程无关的闲聊 → 不调工具
4. 最多检索 3 轮；不要在回复里写最终答案——后续有专门的写作步骤基于你收集的段落生成回答
${ctxTitles.length ? `\n上下文已有段落：${ctxTitles.join('、')}` : ''}`,
  });

  let agentOk = false;
  try {
    await agent.invoke({ messages: msgs });
    agentOk = true;
  } catch (e) {
    em.trace(`⚠️ agent 运行失败：${(e as Error).message.slice(0, 120)}`);
  }

  // ── 回答阶段 ──
  if (pool.length) {
    const top = Math.max(...pool.map((s) => s.score));
    em.route({
      decision: 'rag',
      score: Number(top.toFixed(3)),
      reason: agentOk ? `Agent 检索 ${rounds} 轮，命中 ${pool.length} 段` : 'Agent 不可用，规则路由检索',
    });
    const answer = await answerWithCitations(
      q,
      pool.map((s) => ({ title: s.title, course: s.course, time_range: s.time_range, text: s.text })),
      em
    );
    if (answer === null) {
      em.note('AI 综合暂不可用（网络），以下为命中的段落原文，可点引用或回放查看视频。');
      em.delta(pool.map((s) => `【${s.n}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
    }
    em.segments(pool);
    return;
  }

  // 佐证池为空：追问直答（上下文有段落）或通用直答
  if (agentOk) {
    const ctxSegs = collectContextSegments(history);
    if (ctxSegs.length) {
      em.route({ decision: 'context', score: 1, reason: 'Agent 判定上下文已足够回答' });
      const answer = await answerWithCitations(
        q,
        ctxSegs.map((s) => ({ title: s.title, course: s.course, time_range: s.time_range, text: s.text })),
        em
      );
      if (answer === null) {
        em.note('AI 综合暂不可用（网络），以下为上下文段落原文。');
        em.delta(ctxSegs.map((s, i) => `【${i + 1}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
      }
      em.segments(ctxSegs);
      return;
    }
    em.route({ decision: 'direct', score: 0, reason: 'Agent 判定直接回答（与课程库无关）' });
    const answer = await answerDirect(q, em);
    if (answer === null) {
      em.note('AI 暂不可用（网络）。');
      em.delta(DIRECT_FALLBACK);
    }
    em.segments([]);
    return;
  }

  // agent 与 AI 都不可用 → 规则路由兜底
  em.trace('⚠️ 回退规则路由');
  const rule = await routeQuery(q, history);
  if (rule.decision === 'direct' || rule.decision === 'context') {
    em.route({ decision: 'direct', score: Number(rule.score.toFixed(3)), reason: `${rule.reason}（规则兜底）` });
    em.note('AI 暂不可用（网络）。');
    em.delta(DIRECT_FALLBACK);
    em.segments([]);
    return;
  }
  const hits = await searchSegments(q, { databaseUrl, courseId: course, limit: 5 });
  if (!hits.length || isNoHit(hits[0].score)) {
    em.route({ decision: 'direct', score: Number(hits[0]?.score.toFixed(3) ?? 0), reason: '库内无足够相关内容（规则兜底）' });
    em.note('课程库里没有找到相关内容。');
    em.delta(NOHIT_FALLBACK);
    em.segments([]);
    return;
  }
  const segs = toSegmentOut(hits);
  em.route({ decision: 'rag', score: Number(hits[0].score.toFixed(3)), reason: `${rule.reason}（规则兜底）` });
  em.note('AI 综合暂不可用（网络），以下为命中的段落原文，可点引用或回放查看视频。');
  em.delta(segs.map((s) => `【${s.n}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
  em.segments(segs);
}
