/**
 * 卡片校验：程序化筛查 + 待复核队列。
 *
 * 检查项：
 *  字段完整性 / 字幕 ID 存在性与视频对应 / 时间合法性 /
 *  连续模式覆盖缺口 / 跨段重复覆盖 / 摘要要点无依据 /
 *  否定条件丢失 / 摘录冒充完整逐字稿 / 证据待复核标记。
 *
 * 自动校验只作筛查：全部通过的卡片质量 = validated；
 * 可修复问题 → needs_review；硬错误（时间非法/证据不存在）→ rejected。
 * 未通过卡片一律进入待复核队列，不作为已验证结果发布。
 */
import type {
  Card,
  CleanedEvidence,
  ValidationIssue,
  ValidationResult,
  VideoMeta,
} from './types';
import type { ContentTypeConfig } from './config';

export interface ValidateContext {
  evidenceById: Map<string, CleanedEvidence>;
  videosById: Map<string, VideoMeta>;
  configFor: (contentType: string) => ContentTypeConfig;
}

const HARD_ERRORS = new Set(['time-illegal', 'evidence-not-found', 'evidence-video-mismatch']);
/** 要点原文支持度阈值（LCS 覆盖率） */
const SUPPORT_THRESHOLD = 0.6;

export function validateCard(
  card: Card,
  ctx: ValidateContext,
  allCardsOfVideo: Card[] = [card]
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const video = ctx.videosById.get(card.videoId);
  const config = ctx.configFor(card.contentType);

  // 1) 字段完整性
  if (!card.title) issues.push(err('field-missing', 'title 为空'));
  if (!card.summary) issues.push(err('field-missing', 'summary 为空'));
  if (!card.body) issues.push(err('field-missing', 'body 为空'));
  if (!card.evIds.length) issues.push(err('field-missing', 'evIds 为空'));
  if (!card.bvid) issues.push(err('field-missing', 'bvid 为空（无法生成视频出处）'));

  // 2) 字幕 ID 存在性与视频对应
  const segEvidence: CleanedEvidence[] = [];
  for (const id of card.evIds) {
    const ev = ctx.evidenceById.get(id);
    if (!ev) {
      issues.push(err('evidence-not-found', `字幕不存在: ${id}`));
      continue;
    }
    if (ev.videoId !== card.videoId) {
      issues.push(err('evidence-video-mismatch', `字幕 ${id} 属于视频 ${ev.videoId}，与卡片 ${card.videoId} 不符`));
      continue;
    }
    segEvidence.push(ev);
  }

  // 3) 时间合法性
  if (card.tStartMs < 0) issues.push(err('time-illegal', 'tStartMs 为负'));
  if (card.tEndMs !== null && card.tEndMs <= card.tStartMs) {
    issues.push(err('time-illegal', `tEndMs(${card.tEndMs}) <= tStartMs(${card.tStartMs})`));
  }
  if (segEvidence.length) {
    const first = segEvidence[0];
    const last = segEvidence[segEvidence.length - 1];
    if (card.tStartMs > first.tStartMs + 1000) {
      issues.push(err('time-illegal', `卡片起始(${card.tStartMs}) 晚于首条字幕(${first.tStartMs})`));
    }
    if (card.tEndMs !== null && last.tEndMs !== null && card.tEndMs < last.tEndMs - 1000) {
      issues.push(err('time-illegal', `卡片结束(${card.tEndMs}) 早于末条字幕(${last.tEndMs})`));
    }
  }
  if (video?.mode === 'full_transcript' && card.tEndMs !== null && card.tEndMs - card.tStartMs > 15 * 60_000) {
    issues.push(warn('duration-suspect', '段落时长超过 15 分钟，疑似切分失效'));
  }

  // 4) 连续模式覆盖缺口（完整逐字稿不允许段内跳号）
  const requireContinuity = video?.mode === 'full_transcript' && config.validation.requireContinuity;
  if (requireContinuity && segEvidence.length) {
    const seqs = segEvidence.map((e) => e.seq).sort((a, b) => a - b);
    const missing: number[] = [];
    for (let s = seqs[0]; s <= seqs[seqs.length - 1]; s++) {
      if (!seqs.includes(s)) missing.push(s);
    }
    if (missing.length) {
      issues.push(err('coverage-gap', `段内字幕序号不连续，缺失: ${missing.slice(0, 10).join(',')}${missing.length > 10 ? '…' : ''}`));
    }
  }

  // 5) 跨段重复覆盖
  for (const other of allCardsOfVideo) {
    if (other.id === card.id) continue;
    const dup = card.evIds.filter((id) => other.evIds.includes(id));
    if (dup.length) {
      issues.push(err('coverage-overlap', `字幕同时被段落 ${other.id} 覆盖: ${dup.slice(0, 5).join(',')}`));
    }
  }

  // 6) 摘要要点必须能在其引用的字幕中找到依据
  for (const point of card.points) {
    if (!point.evIds.length) {
      issues.push(err('point-without-evidence', `要点无字幕依据: ${point.text.slice(0, 20)}…`));
      continue;
    }
    const supportText = point.evIds
      .map((id) => ctx.evidenceById.get(id)?.cleanText ?? '')
      .join('');
    if (card.genMode === 'agent') {
      // agent 撰写的是转述而非摘句：LCS 严格匹配不适用，改用二元组重叠 +
      // 明确的「需人工抽查」告警（转述支持的自动验证不可靠，交给人）
      const shared = sharedBigrams(point.text, supportText);
      if (shared < 2) {
        issues.push(err('summary-unsupported', `要点与引用字幕无实质内容重叠（公共二元组 ${shared} < 2）: ${point.text.slice(0, 24)}…`));
      }
      issues.push(warn('agent-authored', '会话内 AI 撰写，转述支持度无法全自动验证，需人工抽查原文对照'));
    } else {
      const ratio = containmentRatio(point.text, supportText);
      if (ratio < SUPPORT_THRESHOLD) {
        issues.push(
          err('summary-unsupported', `要点原文支持度 ${(ratio * 100).toFixed(0)}% < ${SUPPORT_THRESHOLD * 100}%: ${point.text.slice(0, 24)}…`)
        );
      }
    }
  }

  // 7) 否定/条件/转折保留检查（相对整段证据）
  if (segEvidence.length) {
    const evidenceText = segEvidence.map((e) => e.cleanText).join('');
    for (const pattern of config.validation.mustKeepPatterns) {
      const inEvidence = countOccurrences(evidenceText, pattern);
      if (inEvidence >= 2 && !card.summary.includes(pattern) && !card.body.includes(pattern)) {
        issues.push(warn('possible-negation-loss', `关键标志「${pattern}」在证据中出现 ${inEvidence} 次，摘要与整理文本均未保留`));
      }
    }
  }

  // 8) 摘录不得冒充完整逐字稿
  if (video && video.mode === 'excerpt' && config.validation.excerptMustBePartial && card.completeness !== 'partial') {
    issues.push(err('excerpt-masquerade', `摘录来源卡片 completeness=${card.completeness}，必须为 partial`));
  }

  // 9) 证据待复核标记透传
  const flagged = segEvidence.filter((e) => (e.reviewFlags ?? []).length);
  if (flagged.length) {
    issues.push(warn('evidence-flagged', `${flagged.length} 条字幕带待复核标记: ${flagged[0].reviewFlags[0]}`));
  }

  const hasError = issues.some((i) => i.severity === 'error');
  const hard = issues.some((i) => i.severity === 'error' && HARD_ERRORS.has(i.code));
  const quality: Card['quality'] = hard ? 'rejected' : hasError ? 'needs_review' : 'validated';

  return { cardId: card.id, issues, quality };
}

export function validateVideoCards(
  cards: Card[],
  video: VideoMeta,
  evidenceById: Map<string, CleanedEvidence>,
  configFor: (contentType: string) => ContentTypeConfig
): ValidationResult[] {
  const videosById = new Map([[video.videoId, video]]);
  return cards.map((c) => validateCard(c, { evidenceById, videosById, configFor }, cards));
}

function err(code: string, detail: string): ValidationIssue {
  return { code, severity: 'error', detail };
}

function warn(code: string, detail: string): ValidationIssue {
  return { code, severity: 'warn', detail };
}

function countOccurrences(text: string, sub: string): number {
  if (!sub) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(sub, from);
    if (idx === -1) break;
    count += 1;
    from = idx + sub.length;
  }
  return count;
}

/** 原文支持度：point 的字符被 evidence 按序覆盖的比例（LCS/长度） */
export function containmentRatio(point: string, evidence: string): number {
  if (!point) return 0;
  if (evidence.includes(point)) return 1;
  const a = [...point];
  const b = [...evidence];
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prevDiagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiagonal + 1 : Math.max(dp[j], dp[j - 1]);
      prevDiagonal = tmp;
    }
  }
  return dp[b.length] / a.length;
}

/** 公共二元组数量（agent 转述要点的弱支持度检查） */
export function sharedBigrams(point: string, evidence: string): number {
  const grams = new Set<string>();
  const han = /[\p{Script=Han}]/u;
  for (let i = 0; i + 2 <= point.length; i++) {
    const g = point.slice(i, i + 2);
    if ([...g].every((ch) => han.test(ch))) grams.add(g);
  }
  let shared = 0;
  for (const g of grams) {
    if (evidence.includes(g)) shared += 1;
  }
  return shared;
}
