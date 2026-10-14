#!/usr/bin/env tsx
/**
 * 视频知识流水线 CLI。
 *
 * 示例：
 *   # 摘录库（倪海厦人纪语料）小样本：只跑本草经第 12 集
 *   tsx scripts/vk/run.ts --source data/corpus/entries.jsonl \
 *     --format excerpt-jsonl --content-type shennong-bencao \
 *     --only-video 03-bencao-ep12 --run-id bencao-ep12
 *
 *   # 完整字幕（SRT）通用讲解
 *   tsx scripts/vk/run.ts --source path/to/lecture.srt --format srt \
 *     --video-id photo-101 --course-id photo --course-name 摄影基础 \
 *     --bvid BV1xxxxxxxx --content-type generic-lecture --run-id photo-101
 *
 *   # 索引写入 PG（需要 DATABASE_URL + embed-server）
 *   tsx scripts/vk/run.ts --source data/corpus/entries.jsonl --only-video 03-bencao-ep12 --index
 */
import path from 'node:path';
import fs from 'node:fs';
import { runPipeline, readJson, ALL_STAGES, type StageName, type VideoMetaInput } from '../../lib/vk/runner';
import { indexRun } from '../../lib/vk/store';
import { createLlmClientFromEnv, createLlmSummarizer } from '../../lib/vk/llm';
import type { InputFormat } from '../../lib/vk/adapters';
import type { Card, Chapter, CleanedEvidence, Segment, ValidationResult, VideoMeta } from '../../lib/vk/types';

function parseArgs(argv: string[]): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      if (key === 'only-video' || key === 'content-type-book') {
        (out[key] as string[] | undefined) ??= [];
        (out[key] as string[]).push(next);
      } else {
        out[key] = next;
      }
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = String(args.source ?? '');
  if (!source) {
    console.error('缺少 --source');
    process.exit(1);
  }

  const stagesArg = args.stages ? String(args.stages).split(',').map((s) => s.trim()) : ALL_STAGES.filter((s) => s !== 'index');
  const stages = stagesArg.filter((s) => s !== 'index') as StageName[];
  // index 默认不执行，必须显式 --index（需要 DATABASE_URL + embed-server）
  const wantIndex = args.index === true;

  let videoMeta: VideoMetaInput | undefined;
  if (args['video-id']) {
    videoMeta = {
      videoId: String(args['video-id']),
      courseId: String(args['course-id'] ?? 'default'),
      courseName: String(args['course-name'] ?? String(args['course-id'] ?? '默认课程')),
      bvid: String(args.bvid ?? ''),
      cid: args.cid ? Number(args.cid) : null,
      part: args.part ? Number(args.part) : 1,
      title: String(args.title ?? ''),
      contentType: args['content-type'] ? String(args['content-type']) : undefined,
    };
  }

  // LLM 可选：--llm 走真实服务（需密钥）；--mock-llm 走假实现（测试链路，结果明确标识 mock）
  let llmSummarizer = null;
  if (args['mock-llm']) {
    const { createMockSummarizer } = await import('../../lib/vk/mock-llm');
    llmSummarizer = createMockSummarizer();
    console.warn('[run] 使用 MOCK LLM（仅验证链路，非真实模型结果）');
  } else if (args.llm) {
    const client = createLlmClientFromEnv();
    if (!client) {
      console.error('[run] --llm 需要 LLM_BASE_URL + LLM_API_KEY + LLM_MODEL 环境变量');
      process.exit(1);
    }
    llmSummarizer = createLlmSummarizer(client);
  }

  // --content-type-book 03-bencao=shennong-bencao（可重复）：按课程覆盖内容类型
  const contentTypeByBook: Record<string, string> = {};
  if (Array.isArray(args['content-type-book'])) {
    for (const pair of args['content-type-book'] as string[]) {
      const [book, type] = pair.split('=');
      if (book && type) contentTypeByBook[book] = type;
    }
  }

  const result = await runPipeline({
    source,
    format: args.format ? (String(args.format) as InputFormat) : undefined,
    videoMeta,
    contentType: args['content-type'] ? String(args['content-type']) : undefined,
    contentTypeByBook: Object.keys(contentTypeByBook).length ? contentTypeByBook : undefined,
    onlyVideoIds: Array.isArray(args['only-video']) ? (args['only-video'] as string[]) : undefined,
    limitVideos: args.limit ? Number(args.limit) : undefined,
    stages,
    force: args.force === true,
    concurrency: args.concurrency ? Number(args.concurrency) : undefined,
    retries: args.retries ? Number(args.retries) : undefined,
    runId: args['run-id'] ? String(args['run-id']) : undefined,
    llmSummarizer,
  });

  console.log(`\n[run] ${result.runId} 完成：${result.videos} 视频 / ${result.cards} 卡片`);
  console.log(
    `[run] 质量分布：validated=${result.quality.validated} needs_review=${result.quality.needsReview} rejected=${result.quality.rejected} draft=${result.quality.draft}`
  );
  for (const [stage, stat] of Object.entries(result.stages)) {
    if (stat.count || stat.skipped) {
      console.log(`[run]   ${stage}: count=${stat.count} skipped=${stat.skipped} ${stat.ms}ms`);
    }
  }
  if (result.errors.length) {
    console.log(`[run] 错误 ${result.errors.length} 条（详见 run-summary.json）：`);
    for (const e of result.errors.slice(0, 10)) console.log(`  - [${e.stage}] ${e.videoId}: ${e.error}`);
  }

  // index 阶段：从产物装配后写 PG
  if (wantIndex) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error('[run] --index 需要 DATABASE_URL');
      process.exit(1);
    }
    const videoDir = path.join(result.runDir, 'videos');
    const videos: VideoMeta[] = [];
    const evidence: CleanedEvidence[] = [];
    const chapters: Chapter[] = [];
    const segments: Segment[] = [];
    const cards: Card[] = [];
    const validation: ValidationResult[] = [];
    for (const f of fs.readdirSync(videoDir)) {
      const v = readJson<{
        video: VideoMeta;
        cleaned: CleanedEvidence[];
        chapters: Chapter[];
        segments: Segment[];
        cards: Card[];
        validation: ValidationResult[];
      }>(path.join(videoDir, f));
      videos.push(v.video);
      evidence.push(...(v.cleaned ?? []));
      chapters.push(...v.chapters);
      segments.push(...v.segments);
      cards.push(...v.cards);
      validation.push(...v.validation);
    }
    console.log(`[run] 索引 ${cards.length} 张卡片 → PG…`);
    const stats = await indexRun({
      databaseUrl,
      runId: result.runId,
      videos,
      evidence,
      chapters,
      segments,
      cards,
      validation,
    });
    console.log(
      `[run] 索引完成：${stats.cards} 卡片 / ${stats.chunks} 块（embed ${stats.embedCalls} 次 / ${stats.embedTexts} 条，${(stats.ms / 1000).toFixed(1)}s）`
    );
    fs.writeFileSync(
      path.join(result.runDir, 'index-summary.json'),
      JSON.stringify(stats, null, 2)
    );
  }
}

main().catch((e) => {
  console.error('[run] 失败:', e);
  process.exit(1);
});
