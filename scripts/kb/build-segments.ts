#!/usr/bin/env tsx
/**
 * 构建语义段落（kb_segment）：按 (book, ep, h2) 分组，句子按时间序拼接，
 * 起止时间取组内首末句 t_hms，段落整体生成 embedding。
 *
 *   DATABASE_URL=… EMBED_URL=http://127.0.0.1:3001 tsx scripts/kb/build-segments.ts
 *   [--dry-run 只看统计不写库] [--course 03-bencao 只建某部]
 *
 * 话题边界来自语料自带的 h2 标注（摘录语料已标好每句话的话题）；
 * 完整字幕到位后，同一张表改由语义分段器填充（起止句子编号 → 程序拼时间）。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const EMBED_DIM = 512;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

/** 'HH:MM:SS' / 'MM:SS' → 秒 */
function hmsToSeconds(v: string): number {
  const parts = v.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(v) || 0;
}

/** h2 展示名：取括号前主名（"半夏（下品草部；…）" → "半夏"） */
function displayTitle(h2: string): string {
  const idx = h2.search(/[（(]/);
  const main = idx > 0 ? h2.slice(0, idx).trim() : h2.trim();
  return main || h2.trim();
}

async function embedTexts(texts: string[], embedUrl: string, retries = 2): Promise<number[][]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${embedUrl.replace(/\/$/, '')}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`embed-server ${res.status}`);
      const { vectors } = (await res.json()) as { vectors: number[][] };
      if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('返回数量不匹配');
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== EMBED_DIM) throw new Error(`维度异常: ${v?.length}`);
      }
      return vectors;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error('unreachable');
}

interface SegmentRow {
  segment_id: string;
  video_id: string;
  course_id: string;
  title: string;
  h2_full: string;
  text: string;
  start_seconds: number;
  end_seconds: number;
  bvid: string;
  ep: number;
  sentence_count: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const embedUrl = process.env.EMBED_URL ?? 'http://127.0.0.1:3001';
  const course = typeof args.course === 'string' ? args.course : undefined;
  const dryRun = args['dry-run'] === true;

  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // 1) schema（幂等）
    const schemaPath = path.resolve(process.cwd(), 'scripts/kb/segments-schema.sql');
    await client.query(fs.readFileSync(schemaPath, 'utf8'));

    // 2) 分组取段落（句子按 t_hms 时间序）
    const params: unknown[] = [];
    let where = '';
    if (course) {
      params.push(course);
      where = 'WHERE book_id = $1';
    }
    const { rows } = await client.query<{
      book_id: string;
      ep: number;
      bvid: string;
      h2: string;
      n: string;
      t0: string;
      t1: string;
      text: string;
    }>(
      `SELECT book_id, ep, min(bvid) AS bvid, h2,
              count(*)::text AS n,
              (array_agg(t_hms ORDER BY t_hms))[1] AS t0,
              (array_agg(t_hms ORDER BY t_hms DESC))[1] AS t1,
              string_agg(quote, '' ORDER BY t_hms) AS text
         FROM corpus_entry ${where}
        GROUP BY book_id, ep, h2
        ORDER BY book_id, ep, min(t_hms)`,
      params
    );

    // 3) 组装（segment_id 按集内序号）
    const segNo = new Map<string, number>();
    const segments: SegmentRow[] = rows.map((r) => {
      const videoId = `${r.book_id}-ep${r.ep}`;
      const n = (segNo.get(videoId) ?? 0) + 1;
      segNo.set(videoId, n);
      return {
        segment_id: `${videoId}-s${String(n).padStart(3, '0')}`,
        video_id: videoId,
        course_id: r.book_id,
        title: displayTitle(r.h2),
        h2_full: r.h2,
        text: r.text.replace(/\s+/g, ' ').trim(),
        start_seconds: hmsToSeconds(r.t0),
        end_seconds: hmsToSeconds(r.t1),
        bvid: r.bvid,
        ep: r.ep,
        sentence_count: Number(r.n),
      };
    });

    const totalChars = segments.reduce((s, x) => s + x.text.length, 0);
    console.log(`[segments] ${segments.length} 段（${segments.reduce((s, x) => s + x.sentence_count, 0)} 句 / ${totalChars} 字）`);
    if (segments.length) {
      const lens = segments.map((s) => s.text.length).sort((a, b) => a - b);
      console.log(`[segments] 段长: 中位 ${lens[Math.floor(lens.length / 2)]} 字 | 最短 ${lens[0]} | 最长 ${lens[lens.length - 1]}`);
    }
    if (dryRun) {
      for (const s of segments.slice(0, 5)) {
        console.log(`  ${s.segment_id} 「${s.title}」 ${s.sentence_count}句 ${s.start_seconds}→${s.end_seconds}s: ${s.text.slice(0, 40)}…`);
      }
      await client.end();
      return;
    }

    // 4) 段落级 embedding（批量；embed-server 单条上限 2000 字，
    //    模型实际只取前 512 字——拼上标题让话题词进向量，长段取头部）
    let embedCalls = 0;
    const BATCH = 32;
    const embedInput = (s: SegmentRow) => `${s.title}：${s.text}`.slice(0, 1800);
    for (let i = 0; i < segments.length; i += BATCH) {
      const slice = segments.slice(i, i + BATCH);
      const vectors = await embedTexts(slice.map(embedInput), embedUrl);
      embedCalls += 1;
      for (let j = 0; j < slice.length; j++) {
        const s = slice[j];
        await client.query(
          `INSERT INTO kb_segment (segment_id, video_id, course_id, title, h2_full, text, start_seconds, end_seconds, bvid, ep, sentence_count, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)
           ON CONFLICT (segment_id) DO UPDATE SET title=EXCLUDED.title, h2_full=EXCLUDED.h2_full, text=EXCLUDED.text,
             start_seconds=EXCLUDED.start_seconds, end_seconds=EXCLUDED.end_seconds, sentence_count=EXCLUDED.sentence_count,
             embedding=EXCLUDED.embedding, created_at=now()`,
          [s.segment_id, s.video_id, s.course_id, s.title, s.h2_full, s.text, s.start_seconds, s.end_seconds, s.bvid, s.ep, s.sentence_count, `[${vectors[j].join(',')}]`]
        );
      }
      if ((i / BATCH) % 5 === 0) console.log(`[segments] embedding ${Math.min(i + BATCH, segments.length)}/${segments.length}…`);
    }
    console.log(`[segments] 完成：${segments.length} 段已入库（embed ${embedCalls} 批）`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[segments] 失败:', e);
  process.exit(1);
});
