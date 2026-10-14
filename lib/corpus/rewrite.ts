/**
 * 追问改写 + 原著意图识别（DeepSeek，Anthropic 兼容端点）
 *
 * 为什么需要：语料检索是无状态的——追问「这个药怎么用」里的「这个药」
 * 指代上一轮内容，直接检索必然跑偏。用 LLM 把对话历史 + 当前问题
 * 改写为独立检索词；同时识别「要古籍原文」的意图（语料是讲座口语，
 * 没有原文，需要诚实降级并指引，不能编造）。
 *
 * 任何失败都静默降级（用原问题、wantsOriginal=false），不影响检索主链路。
 */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  timeout: 20000,
});
const MODEL = process.env.AI_MODEL || 'deepseek-flash';

export interface HistoryTurn {
  role: 'user' | 'ai';
  text: string;
}

export interface RewriteResult {
  /** 改写后的独立检索词 */
  query: string;
  /** 是否在要古籍原文（本库只有讲座口语，需走原文指引降级） */
  wantsOriginal: boolean;
}

const SYSTEM = `你是中医知识库检索查询改写器。用户在与「倪海厦《人纪》讲座语料库」对话。
把用户的当前问题改写成**独立的检索查询**（补上指代、去掉口语语气），用于检索讲座判语。

规则：
1. 只依据对话历史补全指代（如「这个药」→「蛇床子」），不要改变问题本意
2. 输出紧凑的中文检索词（10-30 字），保留关键实体（药名/方名/穴位/条文/症状）
3. 如果用户明确要古籍原文（如「伤寒论原文」「原著怎么写」「原文是什么」），wantsOriginal 为 true
4. 无法改写或当前问题已自包含时，原样返回

只输出 JSON：{"query":"...","wantsOriginal":false}`;

export async function rewriteQuery(
  question: string,
  history: HistoryTurn[]
): Promise<RewriteResult> {
  const fallback: RewriteResult = { query: question, wantsOriginal: false };
  try {
    const hist = history
      .slice(-6)
      .map((h) => `${h.role === 'user' ? '学员' : '系统'}: ${h.text.slice(0, 200)}`)
      .join('\n');
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      thinking: { type: 'disabled' },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: hist ? `对话历史：\n${hist}\n\n当前问题：${question}` : question,
        },
      ],
    });
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text' && b.text.trim().length > 0);
    if (!block) return fallback;
    const jsonText = block.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(jsonText) as { query?: unknown; wantsOriginal?: unknown };
    const query = typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : question;
    return { query: query.slice(0, 100), wantsOriginal: parsed.wantsOriginal === true };
  } catch (e) {
    console.warn('[zhongyi rewrite] 失败，用原问题:', String(e).slice(0, 120));
    return fallback;
  }
}
