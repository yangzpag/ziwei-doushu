/**
 * 提示词模板（可选 LLM 适配器用）。
 *
 * 默认流程不使用 LLM；以下模板供接入任意 OpenAI/Anthropic 兼容服务时使用，
 * 核心约束：只能依据给定字幕、字幕 ID 边界由程序计算、不得编造时间、
 * 信息不足必须标记 needs_context。
 */

export interface PromptInput {
  contentTypeName: string;
  summaryFocus: string;
  targetChars: [number, number];
  /** 可供引用的字幕（id + 文本），模型只能在其中取材 */
  cues: { id: string; text: string }[];
  chapterTitle: string;
}

export const SUMMARIZE_SYSTEM = `你是视频课程知识整理助手。严格遵守：
1. 只能依据下方给出的字幕片段作答，禁止使用任何外部知识；
2. 字幕没讲的内容不要补写；信息不足时在 needs_context 字段说明缺什么；
3. 区分「讲者观点」与外部事实：课程内容一律是讲者观点，不得表述为已证实结论；
4. 不要生成或推测任何时间戳——视频时间点由程序依据字幕 ID 计算；
5. 摘要每个实质性要点必须标注支撑它的字幕 ID（evIds），无依据的句子删除；
6. 摘录材料存在缺口时，不得把零散摘录拼接成连续论述。`;

export function buildSummarizeUserPrompt(input: PromptInput): string {
  const cueLines = input.cues.map((c) => `- [${c.id}] ${c.text}`).join('\n');
  return `内容类型：${input.contentTypeName}
摘要侧重点：${input.summaryFocus}
摘要长度：约 ${input.targetChars[0]}–${input.targetChars[1]} 字
章节：${input.chapterTitle}

可用字幕（只能引用以下 ID）：
${cueLines}

请输出 JSON（不要输出多余文字）：
{
  "title": "段落标题（≤24字，点名主题）",
  "summary": [{"text": "摘要句", "evIds": ["字幕ID"]}],
  "body": "整理文本（删口头冗余，不增加事实）",
  "keywords": ["关键词"],
  "typeFields": {},
  "needsContext": false,
  "needsContextReason": ""
}`;
}
