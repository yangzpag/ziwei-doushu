/**
 * 卡片组装：Segment + CardDraft + VideoMeta → Card。
 * 质量状态由 validate 阶段回写；此处只产出 draft。
 */
import type { Card, Segment, VideoMeta } from './types';
import type { CardDraft } from './summarize';
import { CONFIG_VERSION } from './config';

export const SUMMARIZER_VERSION = 'extractive-1';

export function buildCard(
  segment: Segment,
  draft: CardDraft,
  video: VideoMeta,
  opts: { version?: number; genMode?: Card['genMode']; model?: string | null } = {}
): Card {
  const genMode = opts.genMode ?? 'extractive';
  // 章节原始标题（含「下品；口称267」等注释）完整保留在 typeFields，供展示与检索
  const typeFields: Record<string, unknown> = { ...draft.typeFields };
  if (segment.chapterRaw && segment.chapterRaw !== segment.title) {
    typeFields.chapterFull = segment.chapterRaw;
  }
  return {
    id: segment.id,
    segmentId: segment.id,
    videoId: video.videoId,
    courseId: video.courseId,
    chapter: segment.title,
    contentType: segment.contentType,
    title: draft.title,
    summary: draft.summary,
    points: draft.points,
    body: draft.body,
    keywords: draft.keywords,
    evIds: segment.evIds,
    tStartMs: segment.tStartMs,
    tEndMs: segment.tEndMs,
    bvid: video.bvid,
    cid: video.cid,
    part: video.part,
    typeFields,
    quality: draft.needsContext ? 'needs_review' : 'draft',
    genMode,
    model: opts.model ?? null,
    promptVersion:
      genMode === 'extractive'
        ? `${segment.contentType}@${CONFIG_VERSION}+${SUMMARIZER_VERSION}`
        : `${segment.contentType}@${CONFIG_VERSION}+${genMode}:${opts.model ?? 'unknown'}`,
    completeness: segment.completeness,
    version: opts.version ?? 1,
  };
}
