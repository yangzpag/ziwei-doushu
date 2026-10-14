/**
 * Mock LLM 摘要器 —— 仅用于验证 LLM 链路（解析/回退/字段映射），
 * 输出明确标识为 mock，不得当作真实模型处理结果。
 */
import type { CardPoint } from './types';
import type { CardDraft } from './summarize';
import type { LlmSummarizeInput, Summarizer } from './llm';

export function createMockSummarizer(): Summarizer {
  return {
    mode: 'llm',
    model: 'mock-llm-1',
    async summarize(input: LlmSummarizeInput): Promise<CardDraft> {
      // 伪造成「模型」：按输入字幕原样拼一个草稿，验证字段映射而非质量
      const points: CardPoint[] = input.cues.slice(0, 2).map((c) => ({
        text: `[MOCK] ${c.text}`,
        evIds: [c.id],
      }));
      return {
        title: `[MOCK] ${input.chapterTitle}`.slice(0, 24),
        summary: points.map((p) => p.text).join(''),
        points,
        body: input.cues.map((c) => c.text).join(''),
        keywords: ['mock'],
        typeFields: { viewpoint: 'speaker', mock: true },
        needsContext: input.cues.length < 2,
        notes: ['mock-llm: 非真实模型输出'],
      };
    },
  };
}
