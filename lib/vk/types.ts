/**
 * 通用视频知识流水线 —— 核心类型
 *
 * 设计原则（见 docs/video-kb-pipeline.md）：
 * - 字幕 / OCR / 画面描述统一抽象为带时间戳的 Evidence，第一版以字幕与摘录为主；
 * - 完整逐字稿（full_transcript）与零散摘录（excerpt）严格区分，摘录不得冒充完整稿；
 * - 程序计算视频时间，任何阶段都不允许编造时间戳。
 */

/** 证据类型：第一版以 subtitle / excerpt 为主，ocr / frame 预留接口 */
export type EvidenceKind = 'subtitle' | 'excerpt' | 'ocr' | 'frame';

/** 来源的完整程度：full_transcript = 完整逐字稿；excerpt = 零散摘录 */
export type TranscriptMode = 'full_transcript' | 'excerpt';

export interface Evidence {
  /** 稳定 ID：`${videoId}#${seq}`，全链路可溯源 */
  id: string;
  videoId: string;
  /** 视频内序号（按时间排序后连续） */
  seq: number;
  tStartMs: number;
  /** 来源只提供起始时间时留空——禁用下一条的时间冒充结束时间 */
  tEndMs: number | null;
  /** 原始文本，不可覆盖 */
  rawText: string;
  source: EvidenceKind;
  /** 章节线索等来源元数据（如摘录的 h2/h3/section） */
  meta?: Record<string, string | number>;
}

export interface VideoMeta {
  videoId: string;
  courseId: string;
  courseName: string;
  bvid: string;
  /** 分P CID（如有） */
  cid: number | null;
  /** 分P序号（无分P为 1） */
  part: number;
  title: string;
  /** 完整程度 */
  mode: TranscriptMode;
  /** 内容类型配置 id（可被章节覆盖） */
  contentType: string;
  license: string;
  source: string;
  importVersion: string;
}

export interface CleanedEvidence extends Evidence {
  cleanText: string;
  /** 清洗操作记录（保留与原始 ID 的对应关系） */
  cleanOps: string[];
  /** 待复核标记，如 uncertain-term:药名 */
  reviewFlags: string[];
  /** 被合并/丢弃时指向目标 ID；独立成行保留可溯源性 */
  dropped?: 'noise' | 'duplicate' | null;
  mergedInto?: string;
}

export interface Chapter {
  id: string;
  videoId: string;
  title: string;
  /** 章节级内容类型（null = 跟随视频配置） */
  contentType: string | null;
  tStartMs: number;
  tEndMs: number | null;
  evFromId: string;
  evToId: string;
  /** 章节识别方式 */
  detection: 'source-field' | 'keyword' | 'fallback';
}

export type Completeness = 'complete' | 'partial' | 'needs_context';

export interface Segment {
  id: string;
  videoId: string;
  chapterId: string;
  contentType: string;
  title: string;
  /** 章节原始标题（含括号注释，如「半夏（下品草部；本11 口称267 未展开之后）」） */
  chapterRaw: string;
  /** 覆盖的字幕 ID（程序切分的唯一边界依据） */
  evIds: string[];
  tStartMs: number;
  tEndMs: number | null;
  /** 与前一版段之间的缺口（excerpt 模式常见） */
  gapBeforeMs: number | null;
  /** 段内相邻证据的起始间隔（摘录不连续的直接证据） */
  internalGapsMs: number[];
  completeness: Completeness;
  status: 'ok' | 'needs_context' | 'review';
  pipelineVersion: string;
}

/** 摘要要点 → 支撑它的字幕 ID */
export interface CardPoint {
  text: string;
  evIds: string[];
}

export interface Card {
  id: string;
  segmentId: string;
  videoId: string;
  courseId: string;
  chapter: string;
  contentType: string;
  title: string;
  summary: string;
  points: CardPoint[];
  /** 整理文本（展开阅读用；只删口头冗余，不增加事实） */
  body: string;
  keywords: string[];
  evIds: string[];
  tStartMs: number;
  tEndMs: number | null;
  bvid: string;
  cid: number | null;
  part: number;
  /** 类型专属可选字段（不为了满足 schema 补写不存在的事实） */
  typeFields: Record<string, unknown>;
  quality: 'draft' | 'validated' | 'needs_review' | 'rejected';
  /**
   * 生成方式：
   * - extractive = 确定性抽取（默认，无外部调用）；
   * - agent      = 会话内 AI 助手直接分析语料撰写（小批量，需人工抽查）；
   * - llm        = 外部 LLM API（可选适配器，默认不启用）；
   * - mock       = 测试链路用的假实现。
   */
  genMode: 'extractive' | 'agent' | 'llm' | 'mock';
  model: string | null;
  promptVersion: string | null;
  completeness: Completeness;
  version: number;
}

/** 检索块：head（标题+摘要+关键词）与 body（正文拆块）统一关联父 segment */
export interface Chunk {
  id: string;
  cardId: string;
  segmentId: string;
  kind: 'head' | 'body';
  ordinal: number;
  text: string;
}

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warn';
  detail: string;
}

export interface ValidationResult {
  cardId: string;
  issues: ValidationIssue[];
  quality: Card['quality'];
}
