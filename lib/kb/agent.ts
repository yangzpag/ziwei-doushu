/**
 * 课程问答 Agent —— LangChain（ChatAnthropic + bindTools）+ 受控循环。
 *
 * 语义（用户明确要求）：
 *   - RAG 只是 agent 的工具（search_course_segments）；agent 自主决定调不调、搜什么
 *   - 有足够信息（上下文段落 / 自身知识）→ 直接回答，不必调 RAG
 *   - 需要课程佐证 → 检索（最多 2 轮，第二轮换角度）→ 综合回答逐字流式
 *   - 回答是主角；佐证段落默认折叠展示，[n] 角标可跳转视频
 *
 * 为什么自己控环而不是 createAgent：createAgent 的循环由 langgraph 管理，
 * 检索轮数没有可靠的硬上限（实测模型无视工具内的上限提示连搜 7 轮）；
 * 自控循环保证「最多 2 轮检索 + 1 轮综合」的确定性，综合轮天然逐字流式。
 * 对话历史随请求传递（最近 6 轮），服务端不落库。
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
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

/** agent 最多发起的检索轮数（第 3 轮强制综合回答） */
const MAX_SEARCH_ROUNDS = 2;
/** 佐证池上限：防弱相关段落稀释综合轮的注意力 */
const MAX_POOL = 12;

const AGENT_SYSTEM = `你是倪海厦《人纪》课程问答 agent。规则：
1. 用户问题与课程内容相关（药、方、条文、症状、讲法）→ 先调用检索工具拿课程原文佐证（最多 ${MAX_SEARCH_ROUNDS} 轮，第二轮换角度：相关药材/方剂/症状术语），拿到后直接基于佐证回答，论点标注 [编号]（编号来自检索结果）
2. **课程内容是回答的主体**：任何段落与问题直接相关（提到同一疾病、症状、部位或治法），必须以该段落为回答主体并标注 [编号]；段落里的治法、药方要具体写出（药名、配伍、讲者原话要点），不要泛泛而谈
3. 上下文对话已包含足够信息（追问场景，注意「上下文已有段落」清单）→ 直接回答，不必检索
4. 与课程无关的闲聊或你确定能答的通用问题 → 直接回答，不检索
5. 症状/疾病类问题（「X 怎么治」「X 是什么原因」）按鉴别诊断组织：列出几种可能的原因 → 每种附典型伴随症状与对应治法 → 结尾一行「参考课程段落：[编号] 时间（课程名）…」列出引用的视频位置；课程没覆盖的类型标注「（通用补充）」
6. 课程段落没覆盖的部分可作通用补充，但必须标注「（通用补充）」，且不得覆盖或稀释课程内容；课程里没讲的，明说「课程里没讲」
7. 课程内容是讲者观点，不作绝对化表述；简体中文，分点组织，300-500 字`;

export function toSegmentOut(segments: SegmentHit[]): SegmentOut[] {
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

/** 段落池去重并入（只追加，编号稳定：佐证展开与引用角标不漂移） */
function mergePool(pool: SegmentOut[], incoming: SegmentOut[]): void {
  const seen = new Set(pool.map((s) => s.segment_id));
  for (const s of incoming) {
    if (pool.length >= MAX_POOL) return; // 池满即止（incoming 按分数降序，砍的是最弱尾巴）
    if (seen.has(s.segment_id)) continue;
    seen.add(s.segment_id);
    s.n = pool.length + 1;
    pool.push(s);
  }
}

function toNorm(segs: SegmentOut[]): NormSeg[] {
  return segs.map((s) => ({ title: s.title, course: s.course, time_range: s.time_range, text: s.text }));
}

/** 历史转 LangChain 消息 */
function toMessages(history: HistoryTurn[], q: string): BaseMessage[] {
  const msgs: BaseMessage[] = [];
  for (const h of history.slice(-4)) {
    msgs.push(h.role === 'user' ? new HumanMessage(h.text) : new AIMessage(h.text));
  }
  msgs.push(new HumanMessage(q));
  return msgs;
}

const DIRECT_FALLBACK = '这个问题与课程库无关。当前网络暂时无法调用 AI 通用回答，你可以换个课程相关的问题（药名、方剂、症状、条文）试试。';
const NOHIT_FALLBACK = '课程库里没有找到与这个问题相关的内容。当前网络暂时无法调用 AI 通用回答。';

/**
 * Agent 主流程：
 *   1-2 轮：带检索工具的模型调用（模型自主决定搜什么；结果喂回）
 *   第 3 轮：无工具强制综合，流式输出（这轮的回答就是给用户看的内容）
 * 每轮检索经 trace 透出；佐证池经工具闭包累计。
 */
export async function runAgent(
  q: string,
  course: string | undefined,
  history: HistoryTurn[],
  em: Emitter
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const pool: SegmentOut[] = []; // 佐证池（工具闭包累计；编号稳定只追加）
  let aiAvailable = true;

  const model = new ChatAnthropic({
    model: process.env.AI_MODEL || 'deepseek-chat',
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(process.env.ANTHROPIC_BASE_URL ? { anthropicApiUrl: process.env.ANTHROPIC_BASE_URL } : {}),
    maxRetries: 0,
    clientOptions: { timeout: 45_000 },
  });

  const searchDef = {
    type: 'function' as const,
    function: {
      name: 'search_course_segments',
      description:
        '检索倪海厦《人纪》课程（伤寒论/金匮要略/神农本草经/黄帝内经/仲景心法/针灸大成）的语义段落。技巧：现代病名要换算成中医术语与药名再检索（如鼻炎/鼻窦炎→鼻渊、辛夷、菖蒲、苍耳子；打嗝→呃逆、旋覆花；湿疹→湿疮、麻黄加术汤）；命中的段落里提到其他药名/方名且与问题相关时，下一轮优先检索那些药名。',
      parameters: {
        type: 'object',
        properties: {
          query: z.string().min(1).describe('检索关键词，如：辛夷、条336、湿疹'),
        },
        required: ['query'],
      },
    },
  };

  // ── 工具轮（最多 MAX_SEARCH_ROUNDS 轮） ──
  // 增量式 msgs：每轮把 assistant(tool_calls) + ToolMessage 追加进去，
  // 下一轮模型能看到之前所有轮的检索结果（盲轮会让第二轮乱漂）；
  // 且 ToolMessage 前必须有对应 assistant 消息，否则 Anthropic 协议直接拒绝
  const msgs: BaseMessage[] = toMessages(history, q);
  for (let round = 1; round <= MAX_SEARCH_ROUNDS; round++) {
    let res: AIMessage;
    try {
      res = (await model
        .bindTools([searchDef])
        .invoke(msgs, { timeout: 30_000 })) as AIMessage;
    } catch (e) {
      aiAvailable = false;
      em.trace(`⚠️ agent 调用失败：${(e as Error).message.slice(0, 100)}`);
      break; // 网络不通 → 跳出走兜底
    }

    const toolCalls = res.tool_calls ?? [];
    if (!toolCalls.length) {
      // 模型直接回答了（无需检索）—— 整段一次性输出（少见路径）
      const text = typeof res.content === 'string' ? res.content : '';
      if (text) {
        em.delta(text);
        em.route({
          decision: 'direct',
          score: 0,
          reason: round === 1 ? 'Agent 判定无需检索，直接回答' : `Agent 检索 ${round - 1} 轮后直接回答`,
        });
        em.segments([]);
        return;
      }
      break;
    }

    // 记录本轮 assistant 的 tool_calls——ToolMessage 必须紧跟其后（协议要求）
    msgs.push(res);

    for (const tc of toolCalls) {
      if (tc.name !== 'search_course_segments') continue;
      const query = String((tc.args as { query?: unknown })?.query ?? q);
      em.trace(`🔍 检索（第 ${round} 轮）：${query}`);
      const hits = await searchSegments(query, { databaseUrl, courseId: course, limit: 5 });
      if (!hits.length) {
        em.trace('👀 没有命中任何段落');
        msgs.push(new ToolMessage({ content: '没有命中任何课程段落，换关键词或直接基于已有信息回答。', tool_call_id: tc.id ?? `call_r${round}` }));
        continue;
      }
      const outs = toSegmentOut(hits);
      mergePool(pool, outs);
      em.trace(`👀 命中 ${hits.length} 段（累计 ${pool.length} 段）：${hits.slice(0, 3).map((h) => `《${h.title}》`).join(' ')}${hits.length > 3 ? ' …' : ''}`);
      msgs.push(
        new ToolMessage(
          outs
            .map((o) => {
              const n = pool.findIndex((p) => p.segment_id === o.segment_id) + 1;
              return `[${n}] 《${o.title}》（${o.course}，${o.time_range}）\n${o.text}`;
            })
            .join('\n\n'),
          tc.id ?? `call_r${round}`
        )
      );
    }
  }

  // ── 综合轮（无工具，流式逐字） ──
  const ctxTitles = collectContextSegments(history).map((s) => s.title);
  let deltas = 0;
  try {
    // 综合轮必须复用含工具结果的完整消息列表——重建消息会把佐证丢光，
    // 模型只能凭自身知识写答案（菖蒲治鼻窦炎被无视就是这个原因）
    // 收尾指令：输出结构与引用规则在此硬化（埋在系统提示里模型会无视）
    const synthMsgs = pool.length
      ? [
          ...msgs,
          new HumanMessage(
            `基于以上课程段落生成最终回答，严格遵守：
1. 结构：分点列出几种可能的情况/类型 → 每种附典型伴随症状与对应治法（课程里的药方要具体写出药名与配伍）→ 结尾一行「参考课程段落」
2. 课程段落与问题直接相关的内容必须是回答主体；你的通用医学知识只作补充，且补充处标注「（通用补充）」
3. 凡引用课程段落处必须标注 [编号]（编号见上方检索结果）；结尾一行「参考课程段落：」按引用顺序列出 [编号] 时间区间（课程名）
4. 简体中文，Markdown 分节`
          ),
        ]
      : msgs;
    const stream = await model.stream(synthMsgs, { timeout: 60_000 });
    for await (const chunk of stream) {
      const type = typeof chunk.getType === 'function' ? chunk.getType() : '';
      if (type !== 'ai') continue;
      const text = typeof chunk.content === 'string' ? chunk.content : '';
      if (text) {
        em.delta(text);
        deltas += 1;
      }
    }
  } catch {
    aiAvailable = false;
  }

  // ── 收尾：路由标注 + 佐证 ──
  const decided = pool.length
    ? {
        decision: 'rag',
        score: Number(Math.max(...pool.map((s) => s.score)).toFixed(3)),
        reason: `Agent 自主检索 ${Math.min(MAX_SEARCH_ROUNDS, pool.length)} 轮，佐证 ${pool.length} 段`,
      }
    : {
        decision: ctxTitles.length ? 'context' : 'direct',
        score: 0,
        reason: aiAvailable ? 'Agent 判定直接回答' : 'Agent 不可用（网络）',
      };
  em.route(decided);

  if (deltas === 0) {
    // 综合轮没吐出文本（网络中断）→ 程序化兜底
    aiAvailable = false;
    if (pool.length) {
      em.note('AI 综合暂不可用（网络），以下为命中的段落原文，可点引用或回放查看视频。');
      em.delta(pool.map((s) => `【${s.n}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
    } else if (decided.decision === 'context') {
      const ctx = collectContextSegments(history);
      em.note('AI 综合暂不可用（网络），以下为上下文段落原文。');
      em.delta(ctx.map((s, i) => `【${i + 1}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
      em.segments(ctx);
      return;
    } else {
      em.note('AI 暂不可用（网络）。');
      em.delta(NOHIT_FALLBACK);
    }
  } else if (pool.length === 0 && !aiAvailable) {
    em.note('AI 暂不可用（网络）。');
  }
  em.segments(pool);
  void aiAvailable;
}
