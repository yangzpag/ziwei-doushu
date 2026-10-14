/**
 * 知识卡片生成 —— 确定性抽取式（extractive）摘要器。
 *
 * 刻意不调用任何外部 LLM：全部要点必须能在字幕原文中找到依据，
 * 每个要点关联支撑它的字幕 ID；信息不足时输出 needs_context，
 * 不补写缺失讲解。LLM 生成器作为可选适配器预留（lib/vk/llm.ts），
 * 默认流程不使用。
 */
import type {
  CardPoint,
  CleanedEvidence,
  Segment,
  VideoMeta,
} from './types';
import type { ContentTypeConfig } from './config';
import type { Glossary } from './glossary';
import { displayTitle } from './segment';

export interface CardDraft {
  title: string;
  summary: string;
  points: CardPoint[];
  body: string;
  keywords: string[];
  typeFields: Record<string, unknown>;
  needsContext: boolean;
  notes: string[];
}

interface Sentence {
  text: string;
  evId: string;
  order: number;
  score: number;
}

const KEYWORD_STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '就是', '什么', '怎么', '为什么',
  '可以', '可能', '应该', '如果', '因为', '所以', '但是', '而且', '一个', '一些', '没有',
  '不是', '这样', '那样', '现在', '时候', '知道', '觉得', '发现', '出现', '使用', '东西',
  '事情', '问题', '方法', '一样', '这样', '非常', '比较', '已经', '还是', '或者', '以及',
  '然后', '最后', '首先', '其实', '记得', '希望', '你好', '大家', '倪师', '老师',
]);

export function summarizeSegment(
  segment: Segment,
  evidenceById: Map<string, CleanedEvidence>,
  video: VideoMeta,
  config: ContentTypeConfig,
  glossary: Glossary | null
): CardDraft {
  const notes: string[] = [];
  const cues = segment.evIds
    .map((id) => evidenceById.get(id))
    .filter((e): e is CleanedEvidence => Boolean(e && e.cleanText));

  // 1) 切句（保留所属字幕 ID）
  const sentences: Sentence[] = [];
  cues.forEach((cue, ci) => {
    const parts = cue.cleanText.split(/(?<=[。！？…])/).map((s) => s.trim()).filter(Boolean);
    for (const text of parts) {
      sentences.push({ text, evId: cue.id, order: sentences.length, score: 0 });
    }
    void ci;
  });

  // 2) 打分：数值/剂量、否定/条件、术语命中、位置、长度
  for (const s of sentences) {
    let score = 0;
    for (const p of config.summary.priorityPatterns) {
      if (safeTest(p, s.text)) score += 3;
    }
    if (glossary) {
      const hits = glossary.match(s.text).filter((m) => m.certainty === 'certain');
      if (hits.length) score += Math.min(hits.length, 3) * 2;
    }
    if (s.order === 0) score += 1;
    if (s.text.length >= 10 && s.text.length <= 80) score += 1;
    if (s.text.length < 6) score -= 2;
    if (s.text.length > 150) score -= 2;
    s.score = score;
  }

  // 3) 选择：按分选、按原文顺序排；达到目标区间即止
  const [minChars, maxChars] = config.summary.targetChars;
  const ranked = [...sentences].sort((a, b) => b.score - a.score || a.order - b.order);
  const picked: Sentence[] = [];
  let total = 0;
  for (const s of ranked) {
    if (s.score <= 0 && picked.length) break;
    if (picked.length && total + s.text.length > maxChars) break;
    picked.push(s);
    total += s.text.length;
    if (total >= minChars) break;
  }
  if (!picked.length && ranked.length) picked.push(ranked[0]);
  picked.sort((a, b) => a.order - b.order);

  // 4) 要点 → 字幕依据。摘要拼接时在不同字幕的引文之间补「；」分隔
  //    （仅显示层分隔，不改写引文内容，不增加事实）
  const points: CardPoint[] = [];
  for (const s of picked) {
    const last = points[points.length - 1];
    if (last && last.evIds.includes(s.evId)) {
      last.text += s.text;
    } else {
      points.push({ text: s.text, evIds: [s.evId] });
    }
  }
  const summary = points
    .map((p, i) => {
      const needsSep = i > 0 && !/[。！？…；，、]/.test(p.text.slice(-1));
      return needsSep ? `；${p.text}` : p.text;
    })
    .join('');

  // 5) 标题
  const title = buildTitle(segment, cues, config);

  // 6) 整理文本：删口头冗余，不增加事实
  const rawBody = cues.map((c) => c.cleanText).join('');
  const { text: body, removed } = removeFillers(rawBody, config.summary.fillerPatterns);
  if (removed) notes.push(`filler-removed:${removed}`);

  // 7) 关键词：词表术语 + 高频 2-4 gram
  const keywords = extractKeywords(cues, glossary);

  // 8) 类型专属字段（可选）：词表实体 / 正则字段 / 观点属性
  const typeFields: Record<string, unknown> = {};
  for (const field of config.structuredFields) {
    if (field.fromGlossary && glossary) {
      const freq = new Map<string, number>();
      for (const c of cues) {
        for (const m of glossary.match(c.cleanText)) {
          if (m.certainty !== 'certain') continue;
          freq.set(m.term, (freq.get(m.term) ?? 0) + 1);
        }
      }
      const list = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
      if (list.length) typeFields[field.name] = list;
    } else if (field.patterns?.length) {
      const found = new Set<string>();
      for (const c of cues) {
        for (const p of field.patterns) {
          for (const m of c.cleanText.matchAll(safeRegexGlobal(p))) {
            found.add(m[0]);
          }
        }
      }
      if (found.size) typeFields[field.name] = field.kind === 'list' ? [...found] : [...found][0];
    }
  }
  // 讲座语料一律标记为讲者观点，不作为已证实结论
  typeFields.viewpoint = 'speaker';

  // 9) 上下文不足判定
  const totalChars = cues.reduce((s, c) => s + c.cleanText.length, 0);
  const maxGap = segment.internalGapsMs.length ? Math.max(...segment.internalGapsMs) : 0;
  const needsContext =
    cues.length < config.segment.minEvidence ||
    totalChars < config.segment.minChars ||
    maxGap > config.segment.gapMs ||
    segment.completeness === 'needs_context';
  if (needsContext) {
    notes.push(
      `needs_context: evidence=${cues.length}/${config.segment.minEvidence}, chars=${totalChars}/${config.segment.minChars}, maxGapMs=${maxGap}`
    );
  }

  return { title, summary, points, body, keywords, typeFields, needsContext, notes };
}

/** 整理文本构建（agent 撰写卡片时复用：删口头冗余，不增加事实） */
export function buildBodyFromCues(
  cues: CleanedEvidence[],
  config: ContentTypeConfig
): { text: string; removed: number } {
  const rawBody = cues.map((c) => c.cleanText).join('');
  return removeFillers(rawBody, config.summary.fillerPatterns);
}

function buildTitle(
  segment: Segment,
  cues: CleanedEvidence[],
  config: ContentTypeConfig
): string {
  // 摘录模式：章节标题即药材/篇目名（h2 主名）
  const chapterMain = displayTitle(segment.title);
  if (segment.title && chapterMain) return chapterMain;
  // 完整字幕：取第一个像样的句子截断
  const first = cues[0]?.cleanText ?? '';
  const sent = first.split(/(?<=[。！？…])/).find((s) => s.trim().length >= 4) ?? first;
  const clean = sent.replace(/[。！？…]+$/, '').trim();
  void config;
  return clean.slice(0, 24) || '未命名段落';
}

export function removeFillers(
  text: string,
  fillers: string[]
): { text: string; removed: number } {
  let out = text;
  let removed = 0;
  for (const f of [...fillers].sort((a, b) => b.length - a.length)) {
    if (!f) continue;
    for (;;) {
      const idx = out.indexOf(f);
      if (idx === -1) break;
      out = out.slice(0, idx) + out.slice(idx + f.length);
      removed += 1;
    }
  }
  out = out
    .replace(/，{2,}/g, '，')
    .replace(/。{2,}/g, '。')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: out, removed };
}

function extractKeywords(cues: CleanedEvidence[], glossary: Glossary | null): string[] {
  const freq = new Map<string, number>();
  const text = cues.map((c) => c.cleanText).join('');
  const glossaryTerms = new Set<string>();

  if (glossary) {
    for (const c of cues) {
      for (const m of glossary.match(c.cleanText)) {
        if (m.certainty !== 'certain') continue;
        glossaryTerms.add(m.term);
        freq.set(m.term, (freq.get(m.term) ?? 0) + 2); // 词表术语加权
      }
    }
  }

  // 2-4  gram 频率（中文无分词，取连续片段；停用词过滤）
  const han = /[\p{Script=Han}]/u;
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= text.length; i++) {
      const gram = text.slice(i, i + n);
      if (![...gram].every((ch) => han.test(ch))) continue;
      if (KEYWORD_STOPWORDS.has(gram)) continue;
      if (glossaryTerms.has(gram)) continue;
      // 避免与已收录更长词重叠
      let covered = false;
      for (const t of freq.keys()) {
        if (t.includes(gram)) {
          covered = true;
          break;
        }
      }
      if (covered) continue;
      freq.set(gram, (freq.get(gram) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => t);
}

function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

function safeRegexGlobal(pattern: string): RegExp {
  return new RegExp(pattern, 'g');
}
