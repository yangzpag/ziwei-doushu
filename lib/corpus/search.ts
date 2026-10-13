/**
 * 语义检索：query → embedding（embed-server）→ pgvector 余弦最近邻。
 * embed-server 不可用时降级为关键词（ILIKE）检索，保证功能可用。
 */
import 'server-only';
import { corpusPool, type CorpusEntry } from './pg';

const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:3001';

/** 把查询向量化；embed-server 挂了返回 null（触发降级） */
async function embedQuery(q: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${EMBED_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [q] }),
      signal: AbortSignal.timeout(30_000), // 冷启动/WASM 预热可能较慢，放宽超时
    });
    if (!res.ok) return null;
    const { vectors } = (await res.json()) as { vectors: number[][] };
    return vectors?.[0] ?? null;
  } catch {
    return null;
  }
}

export type SearchResult = {
  mode: 'vector' | 'keyword';
  entries: CorpusEntry[];
};

/**
 * 检索判语。bookId 为空 = 全库；否则限定部。
 * 向量模式：cosine 距离排序；关键词模式：search_text ILIKE。
 */
export async function searchEntries(
  q: string,
  bookId?: string
): Promise<SearchResult> {
  const trimmed = q.trim();
  if (!trimmed) return { mode: 'vector', entries: [] };

  const vec = await embedQuery(trimmed);
  if (vec) {
    const literal = `[${vec.join(',')}]`;
    const params: unknown[] = [literal];
    let where = '';
    if (bookId) {
      params.push(bookId);
      where = 'WHERE book_id = $2';
    }
    const { rows } = await corpusPool.query<CorpusEntry>(
      `SELECT id, book_id, h2, h3, quote, bvid, ep, t_hms,
              1 - (embedding <=> $1::vector) AS score
         FROM corpus_entry ${where}
        ORDER BY embedding <=> $1::vector
        LIMIT 60`,
      params
    );
    return { mode: 'vector', entries: rows };
  }

  // 降级：关键词（多词 OR 匹配；quote 命中优先）
  const terms = trimmed
    .split(/[\s,，。？！、；：""''（）]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  const list = terms.length ? terms : [trimmed];
  const params: unknown[] = [list];
  let where = `WHERE (${list.map((_, i) => `search_text ILIKE '%' || $1[${i + 1}] || '%'`).join(' OR ')})`;
  if (bookId) {
    params.push(bookId);
    where += ' AND book_id = $2';
  }
  const { rows } = await corpusPool.query<CorpusEntry>(
    `SELECT id, book_id, h2, h3, quote, bvid, ep, t_hms
       FROM corpus_entry ${where}
      ORDER BY (${list.map((_, i) => `quote ILIKE '%' || $1[${i + 1}] || '%'`).join(' OR ')}) DESC, ep
      LIMIT 60`,
    params
  );
  return { mode: 'keyword', entries: rows };
}

/** 课程导读：随机（按 id 稳定采样）取几条作为初始欢迎语素材 */
export async function bookHighlights(bookId: string, limit = 3): Promise<CorpusEntry[]> {
  const { rows } = await corpusPool.query<CorpusEntry>(
    `SELECT id, book_id, h2, h3, quote, bvid, ep, t_hms
       FROM corpus_entry WHERE book_id = $1
      ORDER BY ((id * 2654435761) % 1000), id
      LIMIT $2`,
    [bookId, limit]
  );
  return rows;
}
