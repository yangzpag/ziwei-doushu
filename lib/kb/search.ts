/**
 * 段落检索：查询向量化 → pgvector 余弦 Top-K → 带相似度分数的段落。
 * 混合策略：向量语义 + 标题命中（问题里点名了段落主题，如「条336讲什么」→「条336」）。
 * 标题命中加分带数字边界保护，避免「条1」误中「条117」。
 */
import pg from 'pg';

const EMBED_URL_FALLBACK = 'http://127.0.0.1:3001';
/** 标题命中段落的最低分（强信号：用户直接点名该主题） */
const TITLE_MATCH_FLOOR = 0.72;

export interface SegmentHit {
  segment_id: string;
  video_id: string;
  course_id: string;
  title: string;
  text: string;
  start_seconds: number;
  end_seconds: number;
  bvid: string;
  ep: number;
  sentence_count: number;
  score: number;
}

export async function embedQuery(q: string, embedUrl?: string): Promise<number[]> {
  const base = (embedUrl ?? process.env.EMBED_URL ?? EMBED_URL_FALLBACK).replace(/\/$/, '');
  const res = await fetch(`${base}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: [q] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`embed-server ${res.status}`);
  const { vectors } = (await res.json()) as { vectors: number[][] };
  const v = vectors?.[0];
  if (!Array.isArray(v) || v.length !== 512) throw new Error('embedding 维度异常');
  return v;
}

/** 标题是否被问题点名（数字边界：「条1」不得因「条117」误命中，但独立出现算） */
export function titleNamedInQuery(title: string, q: string): boolean {
  if (title.length < 2) return false;
  let from = 0;
  for (;;) {
    const idx = q.indexOf(title, from);
    if (idx === -1) return false;
    const next = q[idx + title.length];
    // 数字边界：标题以数字结尾时，后邻不能是数字（防「条1」吃「条117」）
    if (!(next && /\d/.test(next) && /\d$/.test(title))) return true;
    from = idx + 1;
  }
}

/** 混合检索（向量 + 标题命中合并）；vec 为已算好的查询向量 */
export async function searchSegmentsByVec(
  q: string,
  vec: number[],
  opts: { databaseUrl: string; courseId?: string; limit?: number } = { databaseUrl: '' }
): Promise<SegmentHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  const vecStr = `[${vec.join(',')}]`;
  const client = new pg.Client({ connectionString: opts.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // 1) 向量 Top-K（独立参数数组：$1 向量，可选 $2 课程，末位 limit）
    const vecParams: unknown[] = [vecStr];
    let courseWhere = '';
    if (opts.courseId) {
      vecParams.push(opts.courseId);
      courseWhere = 'WHERE course_id = $2';
    }
    vecParams.push(limit);
    const { rows: vecRows } = await client.query<SegmentHit & { score: string }>(
      `SELECT segment_id, video_id, course_id, title, text, start_seconds, end_seconds, bvid, ep, sentence_count,
              1 - (embedding <=> $1::vector) AS score
         FROM kb_segment ${courseWhere}
        ORDER BY embedding <=> $1::vector
        LIMIT $${vecParams.length}`,
      vecParams
    );
    const byId = new Map<string, SegmentHit>();
    for (const r of vecRows) {
      byId.set(r.segment_id, { ...r, score: Number(r.score) });
    }

    // 2) 标题命中（问题点名段落主题）——与课程筛选无关，单独查后合并
    const { rows: titleRows } = await client.query<SegmentHit & { score: string }>(
      `SELECT segment_id, video_id, course_id, title, text, start_seconds, end_seconds, bvid, ep, sentence_count,
              1 - (embedding <=> $1::vector) AS score
         FROM kb_segment WHERE $2::text LIKE '%' || title || '%'`,
      [vecStr, q]
    );
    for (const r of titleRows) {
      if (!titleNamedInQuery(r.title, q)) continue;
      const existing = byId.get(r.segment_id);
      const score = Math.max(Number(r.score), TITLE_MATCH_FLOOR);
      if (existing) existing.score = Math.max(existing.score, score);
      else byId.set(r.segment_id, { ...r, score });
    }

    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  } finally {
    await client.end();
  }
}

/** 段落检索（Top-K，带分数） */
export async function searchSegments(
  q: string,
  opts: { databaseUrl: string; courseId?: string; limit?: number } = { databaseUrl: '' }
): Promise<SegmentHit[]> {
  const vec = await embedQuery(q);
  return searchSegmentsByVec(q, vec, opts);
}
