/**
 * 可选 LLM 摘要适配器（默认不启用）。
 *
 * 流水线默认走确定性抽取式摘要（lib/vk/summarize.ts）。
 * 接入 LLM 时：配置环境变量 → createLlmClientFromEnv() 返回客户端 →
 * createLlmSummarizer() 产出 Summarizer，由 runner 注入。
 * 无 API 密钥时返回 null，流水线保持纯本地可跑。
 */
import type { CardPoint } from './types';
import type { CardDraft } from './summarize';
import { SUMMARIZE_SYSTEM, buildSummarizeUserPrompt, type PromptInput } from './prompts';

export interface LlmClient {
  readonly id: string;
  complete(system: string, user: string): Promise<string>;
}

export interface LlmSummarizeInput {
  contentTypeName: string;
  summaryFocus: string;
  targetChars: [number, number];
  chapterTitle: string;
  cues: { id: string; text: string }[];
}

export interface Summarizer {
  readonly mode: 'llm';
  readonly model: string;
  summarize(input: LlmSummarizeInput): Promise<CardDraft>;
}

/** 从环境变量装配 LLM 客户端；缺密钥返回 null（本地流水线不受影响） */
export function createLlmClientFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  const baseUrl = env.LLM_BASE_URL || env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL;
  const apiKey = env.LLM_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY;
  const model = env.LLM_MODEL || env.AI_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return {
    id: `openai-compatible:${model}`,
    async complete(system, user) {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('LLM 返回为空');
      return text;
    },
  };
}

/** 用 LLM 客户端构造 Summarizer；解析失败会抛错（由 runner 回退抽取式） */
export function createLlmSummarizer(client: LlmClient): Summarizer {
  return {
    mode: 'llm',
    model: client.id,
    async summarize(input: LlmSummarizeInput): Promise<CardDraft> {
      const promptInput: PromptInput = {
        contentTypeName: input.contentTypeName,
        summaryFocus: input.summaryFocus,
        targetChars: input.targetChars,
        chapterTitle: input.chapterTitle,
        cues: input.cues,
      };
      const raw = await client.complete(SUMMARIZE_SYSTEM, buildSummarizeUserPrompt(promptInput));
      return parseLlmDraft(raw);
    },
  };
}

/** 容错解析 LLM 输出的 JSON（截取首个 {…} 块） */
export function parseLlmDraft(raw: string): CardDraft {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM 输出不是 JSON');
  const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const points: CardPoint[] = Array.isArray(obj.summary)
    ? (obj.summary as { text?: string; evIds?: string[] }[])
        .filter((p) => typeof p?.text === 'string')
        .map((p) => ({ text: p.text as string, evIds: Array.isArray(p.evIds) ? p.evIds.filter((x): x is string => typeof x === 'string') : [] }))
    : [];
  const summary = points.map((p) => p.text).join('');
  return {
    title: typeof obj.title === 'string' ? obj.title : '',
    summary,
    points,
    body: typeof obj.body === 'string' ? obj.body : '',
    keywords: Array.isArray(obj.keywords) ? obj.keywords.filter((k): k is string => typeof k === 'string') : [],
    typeFields: (obj.typeFields && typeof obj.typeFields === 'object' ? obj.typeFields : {}) as Record<string, unknown>,
    needsContext: obj.needsContext === true,
    notes: typeof obj.needsContextReason === 'string' && obj.needsContextReason
      ? [`needs_context:${obj.needsContextReason}`]
      : [],
  };
}
