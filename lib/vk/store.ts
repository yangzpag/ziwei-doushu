/**
 * PG 存储：把流水线产物写入 vk_* 表（幂等 upsert，可断点重跑）。
 *
 * schema 唯一来源：scripts/vk/schema.sql（仓库根相对路径）。
 * embedding 走本地 embed-server（EMBED_URL，默认 127.0.0.1:3001）。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type {
  Card,
  Chapter,
  Chunk,
  CleanedEvidence,
  Segment,
  ValidationResult,
  VideoMeta,
} from './types';
import { createLimiter, withRetry } from './runner';

const EMBED_DIM = 512;

export interface IndexOptions {
  databaseUrl: string;
  runId: string;
  videos: VideoMeta[];
  evidence: CleanedEvidence[];
  chapters: Chapter[];
  segments: Segment[];
  cards: Card[];
  validation: ValidationResult[];
  embedUrl?: string;
  batch?: number;
  concurrency?: number;
  retries?: number;
}

export interface IndexStats {
  videos: number;
  evidence: number;
  chapters: number;
  segments: number;
  cards: number;
  chunks: number;
  embedCalls: number;
  embedTexts: number;
  ms: number;
}

/** 把卡片切为检索块：head（章节+标题+摘要+关键词）+ body（正文按句界拆 ~220 字） */
export function chunkCard(card: Card): Chunk[] {
  const chunks: Chunk[] = [];
  chunks.push({
    id: `${card.id}-h`,
    cardId: card.id,
    segmentId: card.segmentId,
    kind: 'head',
    ordinal: 0,
    text: [
      card.chapter,
      typeof card.typeFields?.chapterFull === 'string' ? card.typeFields.chapterFull : '',
      card.title,
      card.summary,
      card.keywords.join(' '),
    ]
      .filter(Boolean)
      .join(' ')
      .trim(),
  });
  const body = card.body;
  if (body) {
    const pieces: string[] = [];
    let buf = '';
    for (const sent of body.split(/(?<=[。！？…])/)) {
      if (buf.length + sent.length > 220 && buf) {
        pieces.push(buf);
        buf = '';
      }
      buf += sent;
    }
    if (buf.trim()) pieces.push(buf);
    pieces.forEach((text, i) => {
      chunks.push({
        id: `${card.id}-b${i}`,
        cardId: card.id,
        segmentId: card.segmentId,
        kind: 'body',
        ordinal: i,
        text,
      });
    });
  }
  return chunks;
}

/** 调本地 embed-server；带重试 */
export async function embedTexts(
  texts: string[],
  embedUrl: string,
  retries = 2
): Promise<number[][]> {
  return withRetry(
    async () => {
      const res = await fetch(`${embedUrl.replace(/\/$/, '')}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`embed-server ${res.status}`);
      const { vectors } = (await res.json()) as { vectors: number[][] };
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error('embed-server 返回数量不匹配');
      }
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== EMBED_DIM) {
          throw new Error(`embedding 维度异常: ${v?.length}`);
        }
      }
      return vectors;
    },
    retries
  );
}

export async function indexRun(opts: IndexOptions): Promise<IndexStats> {
  const t0 = Date.now();
  const embedUrl = opts.embedUrl ?? process.env.EMBED_URL ?? 'http://127.0.0.1:3001';
  const batch = opts.batch ?? 32;
  const limit = createLimiter(opts.concurrency ?? 2);
  const client = new pg.Client({ connectionString: opts.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    // 1) schema（幂等）
    const schemaPath = path.resolve(process.cwd(), 'scripts/vk/schema.sql');
    if (!fs.existsSync(schemaPath)) throw new Error(`schema 文件不存在: ${schemaPath}`);
    await client.query(fs.readFileSync(schemaPath, 'utf8'));

    // 2) 视频 / 章节 / 段落（无向量，直接 upsert）
    for (const v of opts.videos) {
      await client.query(
        `INSERT INTO vk_video (video_id, course_id, course_name, bvid, cid, part, title, mode, content_type, license, source, import_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (video_id) DO UPDATE SET course_id=EXCLUDED.course_id, course_name=EXCLUDED.course_name,
           bvid=EXCLUDED.bvid, cid=EXCLUDED.cid, part=EXCLUDED.part, title=EXCLUDED.title, mode=EXCLUDED.mode,
           content_type=EXCLUDED.content_type, license=EXCLUDED.license, source=EXCLUDED.source, import_version=EXCLUDED.import_version`,
        [v.videoId, v.courseId, v.courseName, v.bvid, v.cid, v.part, v.title, v.mode, v.contentType, v.license, v.source, v.importVersion]
      );
    }

    // 证据按视频批量 upsert（jsonb_to_recordset：review_flags/clean_ops 是数组列，unnest 吃不下）
    const evByVideo = new Map<string, CleanedEvidence[]>();
    for (const e of opts.evidence) {
      if (!evByVideo.has(e.videoId)) evByVideo.set(e.videoId, []);
      evByVideo.get(e.videoId)!.push(e);
    }
    for (const [videoId, evs] of evByVideo) {
      for (let i = 0; i < evs.length; i += 500) {
        const b = evs.slice(i, i + 500);
        const rowsJson = b.map((e) => ({
          id: e.id,
          video_id: videoId,
          seq: e.seq,
          t_start_ms: e.tStartMs,
          t_end_ms: e.tEndMs,
          raw_text: e.rawText,
          clean_text: e.cleanText,
          source: e.source,
          meta: e.meta ?? {},
          clean_ops: e.cleanOps ?? [],
          review_flags: e.reviewFlags ?? [],
          dropped: e.dropped ?? null,
          merged_into: e.mergedInto ?? null,
        }));
        await client.query(
          `INSERT INTO vk_evidence (id, video_id, seq, t_start_ms, t_end_ms, raw_text, clean_text, source, meta, clean_ops, review_flags, dropped, merged_into)
           SELECT id, video_id, seq, t_start_ms, t_end_ms, raw_text, clean_text, source, meta, clean_ops, review_flags, dropped, merged_into
             FROM jsonb_to_recordset($1::jsonb) AS x(
               id varchar, video_id varchar, seq int, t_start_ms int, t_end_ms int,
               raw_text text, clean_text text, source varchar, meta jsonb,
               clean_ops jsonb, review_flags text[], dropped varchar, merged_into varchar
             )
           ON CONFLICT (id) DO UPDATE SET t_start_ms=EXCLUDED.t_start_ms, t_end_ms=EXCLUDED.t_end_ms,
             raw_text=EXCLUDED.raw_text, clean_text=EXCLUDED.clean_text, meta=EXCLUDED.meta,
             clean_ops=EXCLUDED.clean_ops, review_flags=EXCLUDED.review_flags, dropped=EXCLUDED.dropped, merged_into=EXCLUDED.merged_into`,
          [JSON.stringify(rowsJson)]
        );
      }
    }

    for (const c of opts.chapters) {
      await client.query(
        `INSERT INTO vk_chapter (id, video_id, title, content_type, t_start_ms, t_end_ms, ev_from_id, ev_to_id, detection)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, content_type=EXCLUDED.content_type,
           t_start_ms=EXCLUDED.t_start_ms, t_end_ms=EXCLUDED.t_end_ms, ev_from_id=EXCLUDED.ev_from_id, ev_to_id=EXCLUDED.ev_to_id, detection=EXCLUDED.detection`,
        [c.id, c.videoId, c.title, c.contentType, c.tStartMs, c.tEndMs, c.evFromId, c.evToId, c.detection]
      );
    }

    for (const s of opts.segments) {
      await client.query(
        `INSERT INTO vk_segment (id, video_id, chapter_id, content_type, title, chapter_raw, ev_ids, t_start_ms, t_end_ms, gap_before_ms, internal_gaps_ms, completeness, status, pipeline_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET content_type=EXCLUDED.content_type, title=EXCLUDED.title, chapter_raw=EXCLUDED.chapter_raw, ev_ids=EXCLUDED.ev_ids,
           t_start_ms=EXCLUDED.t_start_ms, t_end_ms=EXCLUDED.t_end_ms, gap_before_ms=EXCLUDED.gap_before_ms,
           internal_gaps_ms=EXCLUDED.internal_gaps_ms, completeness=EXCLUDED.completeness, status=EXCLUDED.status, pipeline_version=EXCLUDED.pipeline_version`,
        [
          s.id, s.videoId, s.chapterId, s.contentType, s.title, s.chapterRaw, s.evIds,
          s.tStartMs, s.tEndMs, s.gapBeforeMs, s.internalGapsMs, s.completeness, s.status, s.pipelineVersion,
        ]
      );
    }

    // 3) 卡片 upsert
    for (const c of opts.cards) {
      await client.query(
        `INSERT INTO vk_card (id, segment_id, video_id, course_id, chapter, content_type, title, summary, points, body, keywords, ev_ids, t_start_ms, t_end_ms, bvid, cid, part, type_fields, quality, gen_mode, model, prompt_version, completeness, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary, points=EXCLUDED.points,
           body=EXCLUDED.body, keywords=EXCLUDED.keywords, ev_ids=EXCLUDED.ev_ids, t_start_ms=EXCLUDED.t_start_ms,
           t_end_ms=EXCLUDED.t_end_ms, bvid=EXCLUDED.bvid, cid=EXCLUDED.cid, part=EXCLUDED.part,
           type_fields=EXCLUDED.type_fields, quality=EXCLUDED.quality, gen_mode=EXCLUDED.gen_mode,
           model=EXCLUDED.model, prompt_version=EXCLUDED.prompt_version, completeness=EXCLUDED.completeness,
           version=EXCLUDED.version, updated_at=now()`,
        [
          c.id, c.segmentId, c.videoId, c.courseId, c.chapter, c.contentType, c.title, c.summary,
          JSON.stringify(c.points), c.body, c.keywords, c.evIds, c.tStartMs, c.tEndMs,
          c.bvid, c.cid, c.part, JSON.stringify(c.typeFields), c.quality, c.genMode, c.model,
          c.promptVersion, c.completeness, c.version,
        ]
      );
    }

    // 4) 检索块：embed（限流+重试）后 upsert
    const allChunks = opts.cards.flatMap(chunkCard);
    let embedCalls = 0;
    let embedTextsCount = 0;
    for (let i = 0; i < allChunks.length; i += batch) {
      const slice = allChunks.slice(i, i + batch);
      await limit(async () => {
        const vectors = await embedTexts(
          slice.map((c) => c.text),
          embedUrl,
          opts.retries ?? 2
        );
        embedCalls += 1;
        embedTextsCount += slice.length;
        await client.query(
          `INSERT INTO vk_chunk (id, card_id, segment_id, kind, ordinal, text, embedding)
           SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::int[], $6::text[], $7::text[]::vector[])
           ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, embedding=EXCLUDED.embedding`,
          [
            slice.map((c) => c.id),
            slice.map((c) => c.cardId),
            slice.map((c) => c.segmentId),
            slice.map((c) => c.kind),
            slice.map((c) => c.ordinal),
            slice.map((c) => c.text),
            vectors.map((v) => `[${v.join(',')}]`),
          ]
        );
      });
    }

    // 5) 待复核队列（清后重写，保证与最新校验一致）
    await client.query('DELETE FROM vk_review WHERE card_id = ANY($1::varchar[])', [opts.cards.map((c) => c.id)]);
    for (const r of opts.validation) {
      if (r.quality === 'validated') continue;
      const card = opts.cards.find((c) => c.id === r.cardId);
      if (!card) continue;
      const first = r.issues.find((i) => i.severity === 'error') ?? r.issues[0];
      await client.query(
        `INSERT INTO vk_review (card_id, video_id, course_id, quality, reason, detail)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.cardId, card.videoId, card.courseId, r.quality, first?.code ?? 'unknown', JSON.stringify(r.issues)]
      );
    }

    // 6) 运行记录
    await client.query(
      `INSERT INTO vk_run (run_id, stage, status, detail) VALUES ($1,'index','ok',$2)
       ON CONFLICT (run_id, stage) DO UPDATE SET status='ok', detail=EXCLUDED.detail, created_at=now()`,
      [opts.runId, JSON.stringify({ cards: opts.cards.length, chunks: allChunks.length })]
    );

    return {
      videos: opts.videos.length,
      evidence: opts.evidence.length,
      chapters: opts.chapters.length,
      segments: opts.segments.length,
      cards: opts.cards.length,
      chunks: allChunks.length,
      embedCalls,
      embedTexts: embedTextsCount,
      ms: Date.now() - t0,
    };
  } finally {
    await client.end();
  }
}
