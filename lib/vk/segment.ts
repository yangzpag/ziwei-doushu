/**
 * 分章节 + 主题段落切分。
 *
 * 流程：先识别药材/篇目等粗粒度章节，再在章节内切分主题段落。
 * 边界只是候选线索：时长（可配置初始参考）、停顿、口头切换语；
 * 最终以语义完整性（句末标志）决定段落收尾。段落不跨视频/分P
 * （按视频处理，天然满足）。摘录之间存在明显缺口时强制断开，
 * 不得拼接成连续论述。切分只输出字幕 ID 边界，时间由程序计算。
 */
import type {
  Chapter,
  CleanedEvidence,
  Segment,
  VideoMeta,
} from './types';
import { detectChapterType, getConfig, ancestorsOf, type ContentTypeConfig } from './config';

export interface SegmentationResult {
  chapters: Chapter[];
  segments: Segment[];
  coverage: {
    usable: number;
    covered: number;
    skippedIds: string[];
    duplicateIds: string[];
  };
}

const PIPELINE_VERSION = 'vk-seg-2';

export function segmentVideo(
  evidence: CleanedEvidence[],
  video: VideoMeta,
  config: ContentTypeConfig
): SegmentationResult {
  const usable = evidence
    .filter((e) => !e.dropped && !e.mergedInto && e.cleanText)
    .sort((a, b) => a.seq - b.seq);
  const evMap = new Map(usable.map((e) => [e.id, e]));

  // 章节类型识别只在「比视频级配置更具体」的候选里进行，避免被通用配置抢兜底
  const excluded = new Set([video.contentType, ...ancestorsOf(video.contentType)]);
  const candidates = [...new Set(['generic-lecture', 'book-commentary', 'shennong-bencao'])].filter(
    (id) => !excluded.has(id)
  );

  const chapters: Chapter[] = [];
  const groups: CleanedEvidence[][] = [];
  let chNo = 0;

  const pushChapter = (
    title: string,
    evs: CleanedEvidence[],
    detection: Chapter['detection']
  ) => {
    if (!evs.length) return;
    chNo += 1;
    groups.push(evs);
    chapters.push({
      id: `${video.videoId}-c${String(chNo).padStart(3, '0')}`,
      videoId: video.videoId,
      title,
      contentType: detectChapterType(title, evs.map((e) => e.cleanText).join(' '), candidates),
      tStartMs: evs[0].tStartMs,
      tEndMs: evs[evs.length - 1].tEndMs,
      evFromId: evs[0].id,
      evToId: evs[evs.length - 1].id,
      detection,
    });
  };

  buildChapterGroups(usable, video, config, pushChapter);

  const segments: Segment[] = [];
  let segNo = 0;
  chapters.forEach((chapter, ci) => {
    const evs = groups[ci];
    const chapterType = chapter.contentType ?? video.contentType;
    const chapterConfig = chapter.contentType ? getConfig(chapter.contentType) : config;
    for (const seg of splitChapter(evs, evMap, chapter, video, chapterConfig, chapterType)) {
      segNo += 1;
      segments.push({ ...seg, id: `${video.videoId}-s${String(segNo).padStart(3, '0')}` });
    }
  });

  // 覆盖检查：遗漏 / 重复覆盖
  const seen = new Map<string, number>();
  for (const s of segments) for (const id of s.evIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  const coveredIds = new Set(seen.keys());
  const duplicateIds = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const skippedIds = usable.filter((e) => !coveredIds.has(e.id)).map((e) => e.id);

  return {
    chapters,
    segments,
    coverage: { usable: usable.length, covered: coveredIds.size, skippedIds, duplicateIds },
  };
}

/** 粗粒度章节分组：来源字段优先（摘录），强结构线索其次，最后兜底整视频一章 */
function buildChapterGroups(
  usable: CleanedEvidence[],
  video: VideoMeta,
  config: ContentTypeConfig,
  push: (title: string, evs: CleanedEvidence[], detection: Chapter['detection']) => void
): void {
  if (!usable.length) return;

  // 1) 摘录等来源字段（h2/h3…）：字段值变化即新章节
  const sourceField = config.chapter.sourceFields.find((f) =>
    usable.some((e) => e.meta && e.meta[f] !== undefined)
  );
  if (sourceField) {
    let curTitle = String(usable[0].meta?.[sourceField] ?? '');
    let group: CleanedEvidence[] = [];
    for (const e of usable) {
      const val = String(e.meta?.[sourceField] ?? '');
      if (val !== curTitle && group.length) {
        push(curTitle, group, 'source-field');
        group = [];
      }
      curTitle = val;
      group.push(e);
    }
    push(curTitle, group, 'source-field');
    return;
  }

  // 2) 强结构线索（第X章/第X条/卷X…）：命中即新章节
  const patterns = config.chapter.textPatterns.map(safeRegex).filter(Boolean) as RegExp[];
  if (patterns.length) {
    let group: CleanedEvidence[] = [];
    let curTitle = config.chapter.fallbackTitle;
    let groupHasKeyword = false;
    for (const e of usable) {
      const hit = patterns.find((p) => p.test(e.cleanText));
      if (hit && group.length) {
        push(curTitle, group, groupHasKeyword ? 'keyword' : 'fallback');
        group = [];
        groupHasKeyword = false;
      }
      if (hit) {
        const m = e.cleanText.match(hit);
        curTitle = (m?.[0] ?? '').slice(0, 30) || e.cleanText.slice(0, 20);
        groupHasKeyword = true;
      }
      group.push(e);
    }
    push(curTitle, group, groupHasKeyword ? 'keyword' : 'fallback');
    return;
  }

  // 3) 兜底：整视频一章
  push(config.chapter.fallbackTitle || video.title, usable, 'fallback');
}

function safeRegex(p: string): RegExp | null {
  try {
    return new RegExp(p);
  } catch {
    return null;
  }
}

/** 章节内切分主题段落 */
function splitChapter(
  evs: CleanedEvidence[],
  evMap: Map<string, CleanedEvidence>,
  chapter: Chapter,
  video: VideoMeta,
  config: ContentTypeConfig,
  contentType: string
): Segment[] {
  const isExcerptMode = video.mode === 'excerpt';
  const gapThreshold = isExcerptMode ? config.segment.excerpt.gapMs : config.segment.gapMs;
  const maxMergeThreshold = isExcerptMode ? config.segment.excerpt.maxMergeGapMs : config.segment.maxMergeGapMs;
  const transitions = config.segment.transitionPatterns.map(safeRegex).filter(Boolean) as RegExp[];

  const charsOf = (s: Segment) =>
    s.evIds.reduce((n, id) => n + (evMap.get(id)?.cleanText.length ?? 0), 0);
  const isThin = (s: Segment) =>
    s.evIds.length < config.segment.minEvidence || charsOf(s) < config.segment.minChars;

  const segments: Segment[] = [];
  let cur: CleanedEvidence[] = [];
  let gapBefore: number | null = null;
  let lastEnd: number | null = null;

  const close = (status: Segment['status']) => {
    if (!cur.length) return;
    const internalGaps: number[] = [];
    for (let i = 1; i < cur.length; i++) {
      internalGaps.push(cur[i].tStartMs - (cur[i - 1].tEndMs ?? cur[i - 1].tStartMs));
    }
    const isExcerpt = video.mode === 'excerpt';
    const maxGap = internalGaps.length ? Math.max(...internalGaps) : 0;
    let completeness: Segment['completeness'] = isExcerpt ? 'partial' : 'complete';
    if (!isExcerpt && maxGap > config.segment.gapMs) completeness = 'partial';
    const totalChars = cur.reduce((s, e) => s + e.cleanText.length, 0);
    const thin = cur.length < config.segment.minEvidence || totalChars < config.segment.minChars;
    if (status === 'needs_context' || thin) {
      if (completeness === 'complete') completeness = 'needs_context';
    }
    segments.push({
      id: '', // 由调用方编号
      videoId: video.videoId,
      chapterId: chapter.id,
      contentType,
      title: displayTitle(chapter.title),
      chapterRaw: chapter.title,
      evIds: cur.map((e) => e.id),
      tStartMs: cur[0].tStartMs,
      tEndMs: cur[cur.length - 1].tEndMs,
      gapBeforeMs: gapBefore,
      internalGapsMs: internalGaps,
      completeness,
      status,
      pipelineVersion: PIPELINE_VERSION,
    });
    lastEnd = cur[cur.length - 1].tEndMs ?? cur[cur.length - 1].tStartMs;
    cur = [];
  };

  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const startGap = e.tStartMs - prev.tStartMs;
      const hardGap = startGap > maxMergeThreshold; // 缺口：禁止拼接
      const softGap = startGap > gapThreshold; // 候选边界
      const transition = startsWithTransition(e.cleanText, transitions);
      const span = e.tStartMs - cur[0].tStartMs;
      const overRef = span >= config.segment.refDurationMs[1];
      const complete = endsWithSentence(e.cleanText, config.segment.sentenceEnders);
      // 最小段长保护：候选边界只有在本段已「够胖」时才采纳，
      // 否则继续累积——线索只是线索，不机械切分
      const curChars = cur.reduce((s, x) => s + x.cleanText.length, 0);
      const bigEnough = cur.length >= config.segment.minEvidence || curChars >= config.segment.minChars;

      if (hardGap) {
        close('ok'); // 缺口前强制收尾
        gapBefore = startGap;
      } else if ((transition || softGap) && bigEnough && (complete || overRef)) {
        close('ok');
      } else if (overRef && span > config.segment.maxExtendMs) {
        close(complete ? 'ok' : 'needs_context');
      }
    } else if (lastEnd !== null) {
      gapBefore = e.tStartMs - lastEnd;
    }
    cur.push(e);

    if (i === evs.length - 1) {
      close(completeAt(e, config) ? 'ok' : 'needs_context');
    }
  }

  return mergeThinSegments(segments, evMap, config, maxMergeThreshold, transitions);
}

function completeAt(e: CleanedEvidence, config: ContentTypeConfig): boolean {
  return endsWithSentence(e.cleanText, config.segment.sentenceEnders);
}

/**
 * 碎片段合并：低于最小段长的段落（如开场白、结尾告辞）
 * 合并进同章节相邻段（间隔不超过 maxMergeThreshold，摘录缺口不合并）。
 * 合并方向：
 * - 以口头切换语开头的小段（如「我们来看下一个概念，快门。」）→ 向前合并
 *   （它是有意开的新主题，不能并进上一个主题）；
 * - 其余（开场白/结尾语）→ 向后合并进前一段。
 * 合并后重算完整性与状态。
 */
function mergeThinSegments(
  segments: Segment[],
  evMap: Map<string, CleanedEvidence>,
  config: ContentTypeConfig,
  maxMergeThreshold: number,
  transitions: RegExp[]
): Segment[] {
  const charsOf = (s: Segment) =>
    s.evIds.reduce((n, id) => n + (evMap.get(id)?.cleanText.length ?? 0), 0);
  const isThin = (s: Segment) =>
    s.evIds.length < config.segment.minEvidence || charsOf(s) < config.segment.minChars;
  const isExcerpt = (s: Segment) => s.completeness === 'partial' && s.tEndMs === null;
  const startsTopic = (s: Segment) => {
    const first = evMap.get(s.evIds[0]);
    if (!first) return false;
    const head = first.cleanText.slice(0, 20);
    return transitions.some((p) => p.test(head));
  };

  const recompute = (s: Segment): Segment => {
    const gaps = s.internalGapsMs;
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    const thin = isThin(s);
    let completeness: Segment['completeness'] = isExcerpt(s) ? 'partial' : 'complete';
    if (!isExcerpt(s) && maxGap > config.segment.gapMs) completeness = 'partial';
    if (thin && completeness === 'complete') completeness = 'needs_context';
    return { ...s, completeness, status: thin ? 'needs_context' : 'ok' };
  };

  const out: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!isThin(s)) {
      out.push(s);
      continue;
    }
    const gapToPrev = s.gapBeforeMs ?? 0;
    const gapToNext = segments[i + 1]?.gapBeforeMs ?? Number.MAX_SAFE_INTEGER;
    const forward = startsTopic(s); // 切换语开头的小段：向前合并（不开新主题的错并）
    if (!forward && out.length && gapToPrev <= maxMergeThreshold) {
      // 向后合并进前一段
      const prev = out[out.length - 1];
      out[out.length - 1] = recompute({
        ...prev,
        evIds: [...prev.evIds, ...s.evIds],
        tEndMs: s.tEndMs ?? prev.tEndMs,
        internalGapsMs: [
          ...prev.internalGapsMs,
          ...(s.gapBeforeMs !== null ? [s.gapBeforeMs] : []),
          ...s.internalGapsMs,
        ],
      });
      continue;
    }
    if (forward && i + 1 < segments.length && gapToNext <= maxMergeThreshold) {
      // 首段/切换语小段：把后段并进来
      const next = segments[i + 1];
      out.push(
        recompute({
          ...s,
          evIds: [...s.evIds, ...next.evIds],
          tEndMs: next.tEndMs ?? s.tEndMs,
          internalGapsMs: [
            ...s.internalGapsMs,
            ...(next.gapBeforeMs !== null ? [next.gapBeforeMs] : []),
            ...next.internalGapsMs,
          ],
        })
      );
      i += 1;
      continue;
    }
    out.push(recompute(s));
  }
  return out;
}

/** 口头切换语：正则匹配开头一小段（不是字符串 includes，避免「这一节课」误中「下一」） */
function startsWithTransition(text: string, patterns: RegExp[]): boolean {
  const head = text.slice(0, 20);
  return patterns.some((p) => p.test(head));
}

function endsWithSentence(text: string, enders: string[]): boolean {
  const t = text.trimEnd();
  return enders.some((e) => t.endsWith(e));
}

/** 章节标题展示名：摘录 h2 常带括号注释（半夏（下品草部；…）），取主名 */
export function displayTitle(raw: string): string {
  const t = raw.trim();
  const idx = t.search(/[（(]/);
  const main = idx > 0 ? t.slice(0, idx).trim() : t;
  return main || t;
}
