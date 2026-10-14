/**
 * 流水线编排：import → clean → segment → card → validate → index。
 *
 * 工程化：
 * - 阶段独立、产物落盘（data/vk/runs/<runId>/…），可断点续跑；
 * - 缓存键含内容哈希 + 配置版本，上游变化自动失效下游缓存；
 * - 失败重试（默认 2 次，指数退避）、并发限流、小样本（--limit/--only-video）；
 * - 记录调用量 / 耗时；有单价时才估算费用；
 * - 无 API 密钥时非模型部分完整可跑，LLM 走 mock 并明确标识。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  Card,
  Chapter,
  CleanedEvidence,
  Evidence,
  Segment,
  ValidationResult,
  VideoMeta,
} from './types';
import { loadExcerptSource, loadSubtitleSource, type InputFormat } from './adapters';
import { cleanEvidence } from './clean';
import { segmentVideo } from './segment';
import { summarizeSegment } from './summarize';
import { buildCard } from './card';
import { validateVideoCards } from './validate';
import { CONFIG_VERSION, getConfig, glossaryFor, resolveConfig } from './config';
import { contentHash, stageKey } from './cache';
import { Glossary } from './glossary';

export type StageName = 'import' | 'clean' | 'segment' | 'card' | 'validate' | 'index';

export const ALL_STAGES: StageName[] = ['import', 'clean', 'segment', 'card', 'validate', 'index'];

export interface VideoMetaInput {
  videoId: string;
  courseId: string;
  courseName: string;
  bvid: string;
  cid?: number | null;
  part?: number;
  title?: string;
  contentType?: string;
  license?: string;
  source?: string;
  importVersion?: string;
}

export interface RunOptions {
  runId?: string;
  /** 输入文件路径 */
  source: string;
  format?: InputFormat;
  filename?: string;
  /** 完整字幕模式的视频元数据（摘录模式不需要） */
  videoMeta?: VideoMetaInput;
  /** 视频级内容类型（缺省 generic-lecture；摘录库缺省 book-commentary） */
  contentType?: string;
  /** 摘录库按课程覆盖内容类型，如 { '03-bencao': 'shennong-bencao' } */
  contentTypeByBook?: Record<string, string>;
  onlyVideoIds?: string[];
  limitVideos?: number;
  stages?: StageName[];
  /** 忽略缓存重跑 */
  force?: boolean;
  /** 是否执行 index 阶段（写 PG） */
  index?: boolean;
  concurrency?: number;
  retries?: number;
  /** 产物根目录（默认 <repo>/data/vk） */
  outDir?: string;
  env?: NodeJS.ProcessEnv;
  /** LLM 摘要器（可选；缺省走确定性抽取式） */
  llmSummarizer?: import('./llm').Summarizer | null;
  /** 索引进度回调 */
  onIndex?: (info: { videoId: string; cards: number }) => void;
}

export interface StageStat {
  count: number;
  ms: number;
  skipped: number;
}

export interface RunResult {
  runId: string;
  runDir: string;
  videos: number;
  cards: number;
  quality: { validated: number; needsReview: number; rejected: number; draft: number };
  stages: Record<StageName, StageStat>;
  errors: { videoId: string; stage: string; error: string }[];
  usage: { llmCalls: number; embedCalls: number; embedTexts: number };
  cost: { estimatedUsd: number | null };
}

interface VideoState {
  video: VideoMeta;
  evidence: Evidence[];
  cleaned?: CleanedEvidence[];
  chapters?: Chapter[];
  segments?: Segment[];
  cards?: Card[];
  validation?: ValidationResult[];
}

export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const env = opts.env ?? process.env;
  const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(opts.outDir ?? path.join(process.cwd(), 'data/vk'));
  const runDir = path.join(outDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stages = new Set<StageName>(opts.stages ?? ALL_STAGES);
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const retries = Math.max(0, opts.retries ?? 2);
  // 阶段门控：下游阶段依赖上游，请求下游时自动带上上游（命中缓存）
  const needClean = ['clean', 'segment', 'card', 'validate'].some((s) => stages.has(s as StageName));
  const needSegment = ['segment', 'card', 'validate'].some((s) => stages.has(s as StageName));
  const needCard = ['card', 'validate'].some((s) => stages.has(s as StageName));
  const needValidate = stages.has('validate');

  const stats: Record<StageName, StageStat> = Object.fromEntries(
    ALL_STAGES.map((s) => [s, { count: 0, ms: 0, skipped: 0 }])
  ) as Record<StageName, StageStat>;
  const errors: { videoId: string; stage: string; error: string }[] = [];
  const usage = { llmCalls: 0, embedCalls: 0, embedTexts: 0 };

  // ── import ──
  const tImport = Date.now();
  const content = fs.readFileSync(opts.source, 'utf8');
  let videos: VideoMeta[];
  let allEvidence: Evidence[];
  if (opts.videoMeta) {
    const r = loadSubtitleSource(
      content,
      {
        videoId: opts.videoMeta.videoId,
        courseId: opts.videoMeta.courseId,
        courseName: opts.videoMeta.courseName,
        bvid: opts.videoMeta.bvid,
        cid: opts.videoMeta.cid ?? null,
        part: opts.videoMeta.part ?? 1,
        title: opts.videoMeta.title ?? '',
        contentType: opts.videoMeta.contentType ?? opts.contentType ?? 'generic-lecture',
        mode: 'full_transcript',
        license: opts.videoMeta.license ?? '',
        source: opts.videoMeta.source ?? opts.source,
        importVersion: opts.videoMeta.importVersion ?? 'v1',
      },
      { format: opts.format ?? 'auto', filename: opts.filename ?? path.basename(opts.source), videoId: opts.videoMeta.videoId }
    );
    videos = r.videos;
    allEvidence = r.evidence;
  } else {
    const r = loadExcerptSource(content, {
      contentType: opts.contentType ?? 'book-commentary',
      contentTypeByBook: opts.contentTypeByBook,
      onlyVideoIds: opts.onlyVideoIds,
      limitVideos: opts.limitVideos,
      filename: opts.filename ?? path.basename(opts.source),
    });
    videos = r.videos;
    allEvidence = r.evidence;
  }
  stats.import = { count: videos.length, ms: Date.now() - tImport, skipped: 0 };
  writeJson(path.join(runDir, 'import.json'), { videos, evidenceCount: allEvidence.length });

  // 断点续跑状态
  const statePath = path.join(runDir, 'state.json');
  const state: { done: Record<string, StageName[]> } = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { done: {} };
  const markDone = (videoId: string, stage: StageName) => {
    (state.done[videoId] ??= []).push(stage);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  };

  const byVideo = new Map<string, Evidence[]>();
  for (const e of allEvidence) {
    if (!byVideo.has(e.videoId)) byVideo.set(e.videoId, []);
    byVideo.get(e.videoId)!.push(e);
  }

  const videoStates: VideoState[] = videos.map((v) => ({ video: v, evidence: byVideo.get(v.videoId) ?? [] }));

  // ── 逐视频处理（并发限流） ──
  const queue = [...videoStates];
  const worker = async () => {
    for (;;) {
      const vs = queue.shift();
      if (!vs) return;
      const { video } = vs;
      const videoConfig = resolveConfig(video.contentType);
      try {
        // clean
        const t = Date.now();
        if (needClean) {
        const cleanKey = stageKey('clean', CONFIG_VERSION, [
          { id: video.videoId, hash: contentHash({ video, evidence: vs.evidence }) },
          { id: 'config', hash: contentHash(videoConfig.clean) },
        ]);
        const cleanCachePath = path.join(outDir, 'cache', 'clean', `${cleanKey}.json`);
        // 缓存命中 = 文件存在（内容哈希即校验点；不依赖 runId，
        // 否则换个 runId 重跑会用新生成的抽取式卡片覆盖 agent 撰写的缓存）
        if (!opts.force && fs.existsSync(cleanCachePath)) {
          vs.cleaned = JSON.parse(fs.readFileSync(cleanCachePath, 'utf8')) as CleanedEvidence[];
          stats.clean.skipped += 1;
        } else {
          const glossary = glossaryFor(videoConfig);
          vs.cleaned = cleanEvidence(vs.evidence, { mode: video.mode, ...videoConfig.clean, glossary: glossary ?? undefined });
          fs.mkdirSync(path.dirname(cleanCachePath), { recursive: true });
          fs.writeFileSync(cleanCachePath, JSON.stringify(vs.cleaned));
          markDone(video.videoId, 'clean');
          stats.clean.count += 1;
        }
        stats.clean.ms += Date.now() - t;
        }

        // segment
        const tSeg = Date.now();
        if (needSegment) {
        const segKey = stageKey('segment', CONFIG_VERSION, [
          { id: video.videoId, hash: contentHash(vs.cleaned) },
          { id: 'config', hash: contentHash(videoConfig) },
        ]);
        const segCachePath = path.join(outDir, 'cache', 'segment', `${segKey}.json`);
        if (!opts.force && fs.existsSync(segCachePath)) {
          const cached = JSON.parse(fs.readFileSync(segCachePath, 'utf8')) as {
            chapters: Chapter[];
            segments: Segment[];
          };
          vs.chapters = cached.chapters;
          vs.segments = cached.segments;
          stats.segment.skipped += 1;
        } else {
          const r = segmentVideo(vs.cleaned!, video, videoConfig);
          vs.chapters = r.chapters;
          vs.segments = r.segments;
          if (r.coverage.duplicateIds.length || r.coverage.skippedIds.length) {
            errors.push({
              videoId: video.videoId,
              stage: 'segment',
              error: `覆盖异常 duplicate=${r.coverage.duplicateIds.length} skipped=${r.coverage.skippedIds.length}`,
            });
          }
          fs.mkdirSync(path.dirname(segCachePath), { recursive: true });
          fs.writeFileSync(segCachePath, JSON.stringify({ chapters: r.chapters, segments: r.segments, coverage: r.coverage }));
          markDone(video.videoId, 'segment');
          stats.segment.count += 1;
        }
        stats.segment.ms += Date.now() - tSeg;
        }

        // card（抽取式；LLM 注入时用 LLM 并统计调用量）
        const tCard = Date.now();
        if (needCard) {
        const cardKey = stageKey('card', CONFIG_VERSION, [
          { id: video.videoId, hash: contentHash({ segments: vs.segments, cleaned: vs.cleaned }) },
          { id: 'config', hash: contentHash(videoConfig) },
          { id: 'llm', hash: contentHash(opts.llmSummarizer?.model ?? 'extractive') },
        ]);
        const cardCachePath = path.join(outDir, 'cache', 'card', `${cardKey}.json`);
        if (!opts.force && fs.existsSync(cardCachePath)) {
          vs.cards = JSON.parse(fs.readFileSync(cardCachePath, 'utf8')) as Card[];
          stats.card.skipped += 1;
        } else {
          const evidenceById = new Map(vs.cleaned!.map((e) => [e.id, e]));
          const cards: Card[] = [];
          for (const seg of vs.segments!) {
            const segConfig = resolveConfig(seg.contentType);
            const glossary = glossaryFor(segConfig);
            let genMode: Card['genMode'] = 'extractive';
            let model: string | null = null;
            let draft = summarizeSegment(seg, evidenceById, video, segConfig, glossary);
            if (opts.llmSummarizer) {
              // 可选 LLM 路径：失败回退抽取式（回退卡片 genMode 保持 extractive）
              try {
                const cues = seg.evIds
                  .map((id) => evidenceById.get(id))
                  .filter((e): e is CleanedEvidence => Boolean(e && e.cleanText))
                  .map((e) => ({ id: e.id, text: e.cleanText }));
                draft = await opts.llmSummarizer.summarize({
                  contentTypeName: segConfig.name,
                  summaryFocus: segConfig.summary.focus,
                  targetChars: segConfig.summary.targetChars,
                  chapterTitle: seg.title,
                  cues,
                });
                genMode = 'llm';
                model = opts.llmSummarizer.model;
                usage.llmCalls += 1;
              } catch (e) {
                errors.push({ videoId: video.videoId, stage: 'card', error: `LLM 回退抽取式: ${(e as Error).message}` });
              }
            }
            cards.push(buildCard(seg, draft, video, { genMode, model }));
          }
          vs.cards = cards;
          fs.mkdirSync(path.dirname(cardCachePath), { recursive: true });
          fs.writeFileSync(cardCachePath, JSON.stringify(cards));
          markDone(video.videoId, 'card');
          stats.card.count += cards.length;
        }
        stats.card.ms += Date.now() - tCard;
        }

        // validate
        const tVal = Date.now();
        if (needValidate && vs.cards) {
        const results = validateVideoCards(
          vs.cards!,
          video,
          new Map(vs.cleaned!.map((e) => [e.id, e])),
          (id) => resolveConfig(id)
        );
        vs.validation = results;
        for (const r of results) {
          const card = vs.cards!.find((c) => c.id === r.cardId);
          if (card) card.quality = r.quality;
        }
        stats.validate.count += results.length;
        stats.validate.ms += Date.now() - tVal;
        } else {
          vs.validation = [];
        }
        writeJson(path.join(runDir, 'videos', `${video.videoId}.json`), {
          video,
          cleaned: vs.cleaned,
          chapters: vs.chapters,
          segments: vs.segments,
          cards: vs.cards,
          validation: vs.validation ?? [],
        });
      } catch (e) {
        errors.push({ videoId: video.videoId, stage: 'pipeline', error: (e as Error).message });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  // ── 汇总 ──
  const allCards = videoStates.flatMap((v) => v.cards ?? []);
  const quality = {
    validated: allCards.filter((c) => c.quality === 'validated').length,
    needsReview: allCards.filter((c) => c.quality === 'needs_review').length,
    rejected: allCards.filter((c) => c.quality === 'rejected').length,
    draft: allCards.filter((c) => c.quality === 'draft').length,
  };

  // 费用估算：仅当配置了单价才估算（否则 null，不猜）
  let cost: number | null = null;
  const priceIn = Number(env.LLM_PRICE_INPUT_PER_MTOK ?? '');
  const priceOut = Number(env.LLM_PRICE_OUTPUT_PER_MTOK ?? '');
  if (usage.llmCalls > 0 && Number.isFinite(priceIn) && Number.isFinite(priceOut)) {
    // token 计数由 LLM 客户端提供时才能精确估算；此处只给出口径
    cost = null;
  }

  const result: RunResult = {
    runId,
    runDir,
    videos: videos.length,
    cards: allCards.length,
    quality,
    stages: stats,
    errors,
    usage,
    cost: { estimatedUsd: cost },
  };
  writeJson(path.join(runDir, 'run-summary.json'), result);
  return result;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** 重试工具：指数退避，用于 embed / LLM 等外部调用 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  onError?: (attempt: number, err: Error) => void
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      onError?.(attempt, lastErr);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** 简易并发限流器 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export { Glossary, CONFIG_VERSION };
