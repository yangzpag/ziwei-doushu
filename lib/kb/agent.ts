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
  /** 清空当前 assistant 消息已发内容（综合轮泄漏重试前调用，防重复） */
  reset(): void;
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
function mergePool(pool: SegmentOut[], incoming: SegmentOut[]): SegmentOut[] {
  const seen = new Set(pool.map((s) => s.segment_id));
  const added: SegmentOut[] = [];
  for (const s of incoming) {
    if (pool.length >= MAX_POOL) break; // 池满即止（incoming 按分数降序，砍的是最弱尾巴）
    if (seen.has(s.segment_id)) continue;
    seen.add(s.segment_id);
    s.n = pool.length + 1;
    pool.push(s);
    added.push(s);
  }
  return added;
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
 * DeepSeek DSML 工具语法流式过滤器（综合轮泄漏抢救用）。
 * 泄漏形如（分隔符有半角 | 与全角 ｜ 变体，V4 系标签名可能带空格）：
 *   <|DSML|function_calls> <|DSML|invoke name="search_course_segments">
 *   <|DSML|parameter name="query">失眠</|DSML|parameter> </|DSML|function_calls>
 * 也有 <｜tool▁calls▁begin｜> 这类特殊 token 风格。
 * 策略：正文原样透传，工具块整段剥离（不再整次丢弃重试——泄漏输出里
 * 往往夹着可用的回答正文）；跨 chunk 的半截标签用 pending 缓冲衔接。
 */
const DSML_START = /<(?:[｜|\s]{0,3}(?:DSML|tool[▁_]?calls|function[▁_]?calls|invoke\b)|[^>\n]{0,24}DSML)/i;
// 闭合形态两种：斜杠式 </|DSML|...> </|DSML｜invoke>；特殊 token 式 <｜tool▁call▁end｜>
const DSML_END = /(?:<[｜|\s]*\/[^>]*(?:call|invoke|DSML)[^>]*>)|(?:<[｜|\s]*[^>]*[▁_]end[｜|\s]*>)/i;
const DSML_QUERY_RE = /parameter name="query"[^>]*>([^<]+)</g;

export class DsmlStreamFilter {
  private pending = ''; // TEXT 模式下疑似半截标签的尾部缓冲
  private inBlock = false; // 正处于 DSML 工具块内
  private block = ''; // 块内全量累积（闭合标签可能被 chunk 边界切开）
  queries: string[] = []; // 从泄漏块里捕获的检索词（诊断用）
  stripped = 0; // 剥离掉的工具块/碎片数

  feed(text: string): string {
    let buf = this.pending + text;
    this.pending = '';
    let out = '';
    for (let guard = 0; guard < 50 && buf; guard++) {
      if (this.inBlock) {
        this.block += buf;
        buf = '';
        if (this.block.length > 8000) this.block = ''; // 异常长块：弃内容防膨胀（仍留在块内继续丢）
        const m = this.block.match(DSML_END);
        if (m && m.index !== undefined) {
          // 多带一个字符（闭合标签的 '<'）：query 值正则以 '<' 终止，缺它匹配不上
          this.collectQueries(this.block.slice(0, m.index + 1));
          buf = this.block.slice(m.index + m[0].length); // 块后可能还有正文
          this.block = '';
          this.inBlock = false;
        }
        // 未闭合：全量保留在 block 里等后续 chunk（无需 pending，block 不滑窗）
      } else {
        const m = buf.match(DSML_START);
        if (m && m.index !== undefined) {
          out += buf.slice(0, m.index);
          this.block = buf.slice(m.index);
          this.inBlock = true;
          this.stripped += 1;
          buf = '';
          // 起始标记可能同 chunk 内就闭合（如误入的游离闭合标签）
          const em2 = this.block.match(DSML_END);
          if (em2 && em2.index !== undefined) {
            this.collectQueries(this.block.slice(0, em2.index + 1));
            buf = this.block.slice(em2.index + em2[0].length);
            this.block = '';
            this.inBlock = false;
          }
          continue;
        }
        // 无完整起始标记：末尾悬空的 '<' 若像半截标记则缓冲（下个 chunk 定夺）
        const lt = buf.lastIndexOf('<');
        if (lt >= 0 && !buf.slice(lt).includes('>') && buf.length - lt <= 40) {
          out += buf.slice(0, lt);
          this.pending = buf.slice(lt);
        } else {
          out += buf;
        }
        buf = '';
      }
    }
    return out;
  }

  /** 流结束：TEXT 模式吐回缓冲；SKIP 模式块未闭合，直接丢弃 */
  end(): string {
    const rest = this.inBlock ? '' : this.pending;
    this.pending = '';
    this.block = '';
    this.inBlock = false;
    return rest;
  }

  private collectQueries(s: string): void {
    for (const m of s.matchAll(DSML_QUERY_RE)) {
      const v = m[1]?.trim();
      if (v) this.queries.push(v);
    }
  }
}

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
    maxTokens: 8192, // deepseek-flash 现为思维链模型：先输出 thinking 块再出正文，
    // 1024/2048 的预算全被思考吃掉 → 正文零输出（stop_reason=max_tokens）或半截截断
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
  // 综合轮重建上下文的基准线：history + 问题，之后追加的工具轮消息全部排除
  const baseCount = msgs.length;
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

    // DeepSeek 端点偶发把内部工具语法（DSML 标记）当普通文本吐出而非 tool_use 块——
    // 若照常走「无工具=直答」会把原始标记漏给用户。此处解析出检索词并代为执行，
    // 结果以系统消息形式回灌，循环继续
    const rawText = typeof res.content === 'string' ? res.content : '';
    const dsmlQueries = rawText.includes('DSML')
      ? [...rawText.matchAll(/parameter name="query"[^>]*>([^<]+)</g)].map((m) => m[1].trim()).filter(Boolean)
      : [];
    if (!toolCalls.length && dsmlQueries.length) {
      em.trace(`🛠 端点工具语法泄漏，代执行 ${dsmlQueries.length} 组检索`);
      for (const query of dsmlQueries) {
        em.trace(`🔍 检索（第 ${round} 轮·代执行）：${query}`);
        const hits = await searchSegments(query, { databaseUrl, courseId: course, limit: 5 });
        if (hits.length) {
          const added = mergePool(pool, toSegmentOut(hits));
          em.trace(`👀 命中 ${hits.length} 段（新增 ${added.length}，累计 ${pool.length}）`);
        }
      }
      msgs.push(
        new HumanMessage(
          pool.length
            ? `（系统已代执行上述检索，佐证池现有 ${pool.length} 段：${pool.map((p) => `[${p.n}]《${p.title}》`).join(' ')}。请基于现有佐证继续。）`
            : '（系统已代执行上述检索，没有命中段落。）'
        )
      );
      continue;
    }

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
      const added = mergePool(pool, outs);
      em.trace(`👀 命中 ${hits.length} 段（新增 ${added.length}，累计 ${pool.length}）：${hits.slice(0, 3).map((h) => `《${h.title}》`).join(' ')}${hits.length > 3 ? ' …' : ''}`);
      // 工具结果只列实际入池的段落——池满被砍的段落若仍列出，模型会引用
      // 不存在的编号（[0] 就是这么来的）
      msgs.push(
        new ToolMessage(
          added.length
            ? added.map((o) => `[${o.n}] 《${o.title}》（${o.course}，${o.time_range}）\n${o.text}`).join('\n\n')
            : '本批结果与已有佐证重复或佐证池已满，没有新增段落；如已有信息足够请直接回答。',
          tc.id ?? `call_r${round}`
        )
      );
    }
  }

  // ── 综合轮（无工具，流式逐字） ──
  const ctxTitles = collectContextSegments(history).map((s) => s.title);
  let deltas = 0;
  let synthFail = ''; // 失败原因：'leak' 工具语法泄漏 / 'error:...' 异常 / 'empty' 空输出
  try {
    // 关键设计：综合轮不复用含 assistant tool_calls 的消息列表——DeepSeek 看到
    // 历史里的工具调用结构后，综合轮会模仿着继续输出 DSML 工具语法（实测连续
    // 两轮泄漏、重试救不回来）。改为从佐证池重建纯文本上下文：证据一段不丢，
    // 但模型看不到任何工具结构，无从模仿。
    // （旧方案直接复用 msgs 是因为佐证在 ToolMessage 里；现在佐证池本就持有全文）
    const baseMsgs = msgs.slice(0, baseCount);
    const synthMsgs = pool.length
      ? [
          ...baseMsgs,
          new HumanMessage(
            `以下是刚才检索到的课程段落（编号稳定，共 ${pool.length} 段，引用时直接用编号）：\n\n` +
              pool
                .map((s) => `[${s.n}] 《${s.title}》（${s.course}，${s.time_range}）\n${s.text}`)
                .join('\n\n') +
              `\n\n基于以上课程段落生成最终回答，严格遵守：
1. 检索阶段已结束，系统不会再执行任何检索：禁止再发起或伪造任何工具调用/检索语法（如 <|DSML|...>、<invoke>、<parameter> 等），这类内容会被整体丢弃；直接输出给用户看的最终回答
2. 结构：分点列出几种可能的情况/类型 → 每种附典型伴随症状与对应治法（课程里的药方要具体写出药名与配伍）→ 结尾一行「参考课程段落」
3. 课程段落与问题直接相关的内容必须是回答主体；你的通用医学知识只作补充，且补充处标注「（通用补充）」
4. 相关性判断：段落的主题必须真正回答问题才单列为一种情况；仅字面沾边（如别的病里顺带提到某部位、或单味药提了一句）的不单列，最多并入补充说明，宁缺毋滥
5. 去重：同一段落的依据（相同 [编号]）合并到一节里讲完，不许拆成多节重复展开
6. 引用格式：引用课程内容处紧跟 [编号]（方括号数字，如 [2]），禁止写裸数字或不标；结尾一行「参考课程段落：」按引用顺序列出 [编号] 时间区间（课程名），只列正文实际引用过的编号
7. 简体中文，Markdown 分节`
          ),
        ]
      : baseMsgs;
    let answer = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const synthInput =
        attempt === 1
          ? synthMsgs
          : [
              ...synthMsgs,
              new HumanMessage(
                '（系统提示：上一轮你输出了内部检索语法而不是回答。不要再调用任何工具或输出任何检索/DSML 语法，直接基于已有佐证输出最终回答。）'
              ),
            ];
      answer = '';
      deltas = 0; // 每次尝试独立计数：前端 reset 后旧 delta 不再算数
      const filter = new DsmlStreamFilter();
      let lastFr: string | undefined; // 最后一个 chunk 的 finish_reason（有值且非 stop = 被截断）
      let broken = false; // 流中途异常/断开
      try {
        const stream = await model.stream(synthInput, { timeout: 60_000 });
        for await (const chunk of stream) {
          const type = typeof chunk.getType === 'function' ? chunk.getType() : '';
          if (type !== 'ai') continue;
          const fr = (chunk as { response_metadata?: { finish_reason?: string } }).response_metadata?.finish_reason;
          if (fr) lastFr = fr;
          const text = typeof chunk.content === 'string' ? chunk.content : '';
          if (!text) continue;
          // 综合轮未绑工具，DeepSeek 偶发把 DSML 工具语法当纯文本吐出——
          // 逐 chunk 剥离工具块、正文照常流式（不再因泄漏整次丢弃）
          const cleaned = filter.feed(text);
          if (!cleaned) continue;
          answer += cleaned;
          em.delta(cleaned);
          deltas += 1;
        }
      } catch (e) {
        broken = true;
        em.trace(`⚠️ 综合轮流中断：${((e as Error).message ?? '').slice(0, 80)}`);
      }
      const tail = filter.end();
      if (tail) {
        answer += tail;
        em.delta(tail);
        deltas += 1;
      }
      if (filter.stripped) {
        em.trace(
          `🧹 已剥离输出中的 ${filter.stripped} 处工具语法${filter.queries.length ? `（泄漏的检索词：${filter.queries.join('、')}）` : ''}`
        );
      }
      const tooShort = answer.replace(/\s/g, '').length < 80; // 几乎全是工具语法/空
      const truncated = broken || (lastFr !== undefined && lastFr !== 'stop');
      if (!tooShort && !truncated) {
        synthFail = '';
        break;
      }
      if (attempt === 2 && !tooShort && truncated) {
        // 第二次也中断：保留已收到的部分，明示可能不完整（总比倾倒原文好）
        em.note('回答流中途断开，以上内容可能不完整。');
        synthFail = '';
        break;
      }
      synthFail = filter.stripped ? 'leak' : broken ? 'error:stream' : truncated ? 'truncated' : 'empty';
      if (attempt === 1) {
        em.trace(tooShort ? '⚠️ 综合轮输出几乎全是工具语法，重试中' : '⚠️ 综合轮输出中断/截断，重试中');
        em.reset();
      }
    }
  } catch (e) {
    synthFail = `error:${(e as Error).message?.slice(0, 120) ?? 'unknown'}`;
    em.trace(`⚠️ 综合轮调用失败：${synthFail.slice(6)}`);
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
    // 综合轮没吐出文本 → 程序化兜底（按真实原因标注，别一律赖网络）
    aiAvailable = false;
    const failWhy = synthFail.startsWith('leak')
      ? 'AI 综合输出异常（模型持续输出工具语法）'
      : synthFail.startsWith('error')
        ? `AI 综合调用失败（${synthFail.slice(6, 60)}）`
        : synthFail === 'truncated'
          ? 'AI 综合回答被截断（输出预算不足）'
          : synthFail === 'empty'
            ? 'AI 综合返回空内容（模型异常）'
            : 'AI 综合暂不可用（网络）';
    if (pool.length) {
      em.note(`${failWhy}，以下为命中的段落原文，可点引用或回放查看视频。`);
      em.delta(pool.map((s) => `【${s.n}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
    } else if (decided.decision === 'context') {
      const ctx = collectContextSegments(history);
      em.note(`${failWhy}，以下为上下文段落原文。`);
      em.delta(ctx.map((s, i) => `【${i + 1}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
      em.segments(ctx);
      return;
    } else {
      em.note(`${failWhy}。`);
      em.delta(NOHIT_FALLBACK);
    }
  } else if (pool.length === 0 && !aiAvailable) {
    em.note('AI 暂不可用（网络）。');
  }
  em.segments(pool);
  void aiAvailable;
}
