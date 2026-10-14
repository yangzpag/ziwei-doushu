/**
 * 卡片混合检索：向量语义 ∪ 关键词字面，按段落归并，返回完整知识卡片。
 *
 * - head 块（标题+摘要+关键词）与 body 块统一打分，命中同一 segment 归并；
 * - 支持按课程筛选；embed-server 不可用时降级纯关键词；
 * - B 站链接由程序生成（BV 号 + 分P + 秒数）。
 */
import pg from 'pg';
import type { Card, CardPoint } from './types';
import { bilibiliUrl } from './timeline';

export interface CardHit {
  card: Card;
  score: number;
  /** 程序生成的 B 站出处链接 */
  url: string;
  matchedChunks: { id: string; kind: string; score: number }[];
}

export interface SearchOptions {
  databaseUrl: string;
  embedUrl?: string;
  courseId?: string;
  limit?: number;
}

const EMBED_URL_FALLBACK = 'http://127.0.0.1:3001';

async function embedQuery(q: string, embedUrl: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${embedUrl.replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [q] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const { vectors } = (await res.json()) as { vectors: number[][] };
    return vectors?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 关键词词项：先按标点/空格切分；中文问句没有空格时整句是一个长词，
 * 此时补充滑动二元组（bigram）——「本草经下品有哪些药」→ 含「下品」，
 * 「倪师讲怎么急救」→ 含「急救」，避免关键二元组从不参与字面匹配。
 */
function keywordTerms(q: string): string[] {
  const base = q
    .split(/[\s,，。？！、；：""''（）()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  const terms = new Set(base);
  for (const t of base) {
    if (t.length > 4) {
      for (let i = 0; i + 2 <= t.length; i++) terms.add(t.slice(i, i + 2));
    }
  }
  const out = [...terms].slice(0, 16);
  return out.length ? out : [q.trim()].filter(Boolean);
}

export async function searchCards(
  q: string,
  opts: SearchOptions
): Promise<{ mode: 'vector' | 'keyword'; hits: CardHit[] }> {
  const trimmed = q.trim();
  const limit = opts.limit ?? 10;
  if (!trimmed) return { mode: 'vector', hits: [] };
  const embedUrl = opts.embedUrl ?? process.env.EMBED_URL ?? EMBED_URL_FALLBACK;
  const client = new pg.Client({ connectionString: opts.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const vec = await embedQuery(trimmed, embedUrl);
    const terms = keywordTerms(trimmed);
    const courseFilter = opts.courseId ? 'AND c.course_id = $2' : '';
    const baseParams: unknown[] = opts.courseId ? [opts.courseId] : [];

    type ChunkRow = { id: string; card_id: string; segment_id: string; kind: string; score: number };
    let chunkRows: ChunkRow[] = [];

    if (vec) {
      const params: unknown[] = [`[${vec.join(',')}]`];
      let where = '';
      if (opts.courseId) {
        params.push(opts.courseId);
        where = 'WHERE c.course_id = $2';
      }
      const { rows } = await client.query<ChunkRow>(
        `SELECT ch.id, ch.card_id, ch.segment_id, ch.kind,
                1 - (ch.embedding <=> $1::vector) AS score
           FROM vk_chunk ch JOIN vk_card c ON c.id = ch.card_id ${where}
          ORDER BY ch.embedding <=> $1::vector
          LIMIT 40`,
        params
      );
      chunkRows = rows;
    }

    // 关键词字面（向量模式补漏；降级模式独立检索）。按命中词数分级：
    // 字面精确命中比语义相近更可信，命中词越多分越高
    if (!vec || terms.length) {
      const ilike = terms.map((_, i) => `ch.text ILIKE '%' || ($1::text[])[${i + 1}] || '%'`).join(' OR ');
      const titleHit = terms.map((_, i) => `c.title ILIKE '%' || ($1::text[])[${i + 1}] || '%'`).join(' OR ');
      const chapterHit = terms.map((_, i) => `c.chapter ILIKE '%' || ($1::text[])[${i + 1}] || '%'`).join(' OR ');
      const scoreExpr = `(0.4 + 0.1 * (${terms
        .map((_, i) => `(ch.text ILIKE '%' || ($1::text[])[${i + 1}] || '%')::int`)
        .join(' + ')}))`;
      const params: unknown[] = [terms, ...baseParams];
      const { rows } = await client.query<ChunkRow>(
        `SELECT ch.id, ch.card_id, ch.segment_id, ch.kind, ${scoreExpr} AS score
           FROM vk_chunk ch JOIN vk_card c ON c.id = ch.card_id
          WHERE (${ilike} OR ${titleHit} OR ${chapterHit}) ${courseFilter}
          ORDER BY ((${titleHit})::int + (${chapterHit})::int) DESC, score DESC
          LIMIT 20`,
        params
      );      const seen = new Set(chunkRows.map((r) => r.id));
      for (const r of rows) if (!seen.has(r.id)) chunkRows.push(r);
    }

    if (!chunkRows.length) return { mode: vec ? 'vector' : 'keyword', hits: [] };

    // 按 segment 归并：head 加分，同段多块不重复
    const bySeg = new Map<string, { score: number; chunks: ChunkRow[] }>();
    for (const r of chunkRows) {
      const cur = bySeg.get(r.segment_id) ?? { score: 0, chunks: [] };
      const s = Number(r.score) + (r.kind === 'head' ? 0.05 : 0);
      cur.score = Math.max(cur.score, s);
      cur.chunks.push(r);
      bySeg.set(r.segment_id, cur);
    }
    const topSegments = [...bySeg.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit);

    const hits: CardHit[] = [];
    for (const [segmentId, agg] of topSegments) {
      const { rows } = await client.query('SELECT * FROM vk_card WHERE segment_id = $1', [segmentId]);
      if (!rows[0]) continue;
      const card = rowToCard(rows[0]);
      hits.push({
        card,
        score: agg.score,
        url: bilibiliUrl({ bvid: card.bvid, part: card.part, cid: card.cid, tMs: card.tStartMs }),
        matchedChunks: agg.chunks.map((c) => ({ id: c.id, kind: c.kind, score: Number(c.score) })),
      });
    }
    return { mode: vec ? 'vector' : 'keyword', hits };
  } finally {
    await client.end();
  }
}

export async function getCard(cardId: string, databaseUrl: string): Promise<CardHit | null> {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT * FROM vk_card WHERE id = $1', [cardId]);
    if (!rows[0]) return null;
    const card = rowToCard(rows[0]);
    return {
      card,
      score: 1,
      url: bilibiliUrl({ bvid: card.bvid, part: card.part, cid: card.cid, tMs: card.tStartMs }),
      matchedChunks: [],
    };
  } finally {
    await client.end();
  }
}

export async function listCards(opts: {
  databaseUrl: string;
  courseId?: string;
  quality?: string;
  limit?: number;
  offset?: number;
}): Promise<CardHit[]> {
  const client = new pg.Client({ connectionString: opts.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.courseId) {
      params.push(opts.courseId);
      where.push(`course_id = $${params.length}`);
    }
    if (opts.quality) {
      params.push(opts.quality);
      where.push(`quality = $${params.length}`);
    }
    params.push(opts.limit ?? 20);
    params.push(opts.offset ?? 0);
    const { rows } = await client.query(
      `SELECT * FROM vk_card ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY course_id, t_start_ms LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows.map((r) => {
      const card = rowToCard(r);
      return {
        card,
        score: 1,
        url: bilibiliUrl({ bvid: card.bvid, part: card.part, cid: card.cid, tMs: card.tStartMs }),
        matchedChunks: [],
      };
    });
  } finally {
    await client.end();
  }
}

interface CardRow {
  id: string;
  segment_id: string;
  video_id: string;
  course_id: string;
  chapter: string;
  content_type: string;
  title: string;
  summary: string;
  points: CardPoint[] | string;
  body: string;
  keywords: string[] | null;
  ev_ids: string[] | null;
  t_start_ms: number;
  t_end_ms: number | null;
  bvid: string;
  cid: number | null;
  part: number;
  type_fields: Record<string, unknown> | string;
  quality: Card['quality'];
  gen_mode: Card['genMode'];
  model: string | null;
  prompt_version: string | null;
  completeness: Card['completeness'];
  version: number;
}

export function rowToCard(r: CardRow): Card {
  return {
    id: r.id,
    segmentId: r.segment_id,
    videoId: r.video_id,
    courseId: r.course_id,
    chapter: r.chapter,
    contentType: r.content_type,
    title: r.title,
    summary: r.summary,
    points: typeof r.points === 'string' ? (JSON.parse(r.points) as CardPoint[]) : r.points,
    body: r.body,
    keywords: r.keywords ?? [],
    evIds: r.ev_ids ?? [],
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
    bvid: r.bvid,
    cid: r.cid,
    part: r.part,
    typeFields: typeof r.type_fields === 'string' ? JSON.parse(r.type_fields) : r.type_fields ?? {},
    quality: r.quality,
    genMode: r.gen_mode,
    model: r.model,
    promptVersion: r.prompt_version,
    completeness: r.completeness,
    version: r.version,
  };
}
