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
 * 检索判语（混合：向量语义 ∪ 关键词字面）。
 *
 * - 向量召回会漏字面精确匹配的长尾（如「蛇床子…阴湿湿疹」不进 Top60），
 *   因此关键词命中一并并入，保证不漏。
 * - bookId 为空 = 全库；否则限定部。
 */
export async function searchEntries(
  q: string,
  bookId?: string
): Promise<SearchResult> {
  const trimmed = q.trim();
  if (!trimmed) return { mode: 'vector', entries: [] };

  const vec = await embedQuery(trimmed);

  // 关键词词项（两种模式都用：向量模式补字面召回，降级模式独立检索）
  const terms = trimmed
    .split(/[\s,，。？！、；：""''（）]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  const list = terms.length ? terms : [trimmed];
  const kwWhere = `(${list.map((_, i) => `search_text ILIKE '%' || $1[${i + 1}] || '%'`).join(' OR ')})`;
  const kwParams: unknown[] = [list];
  if (bookId) kwParams.push(bookId);
  const kwFilter = bookId ? `${kwWhere} AND book_id = $2` : kwWhere;

  if (vec) {
    const literal = `[${vec.join(',')}]`;
    const vParams: unknown[] = [literal];
    let vWhere = '';
    if (bookId) {
      vParams.push(bookId);
      vWhere = 'WHERE book_id = $2';
    }
    // 向量 Top60（带余弦分）
    const { rows: vecRows } = await corpusPool.query<CorpusEntry>(
      `SELECT id, book_id, h2, h3, quote, bvid, ep, t_hms,
              1 - (embedding <=> $1::vector) AS score
         FROM corpus_entry ${vWhere}
        ORDER BY embedding <=> $1::vector
        LIMIT 60`,
      vParams
    );
    // 关键词字面命中（补漏；quote 命中优先）
    const { rows: kwRows } = await corpusPool.query<CorpusEntry>(
      `SELECT id, book_id, h2, h3, quote, bvid, ep, t_hms, 0.5 AS score
         FROM corpus_entry WHERE ${kwFilter}
        ORDER BY (${list.map((_, i) => `quote ILIKE '%' || $1[${i + 1}] || '%'`).join(' OR ')}) DESC, ep
        LIMIT 20`,
      kwParams
    );
    // 合并去重：字面命中排前（精确匹配更可信），其余按向量分
    const seen = new Set<string>();
    const merged: CorpusEntry[] = [];
    for (const r of [...kwRows, ...vecRows]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    return { mode: 'vector', entries: merged };
  }

  // 降级：纯关键词
  const { rows } = await corpusPool.query<CorpusEntry>(
    `SELECT id, book_id, h2, h3, quote, bvid, ep, t_hms
       FROM corpus_entry WHERE ${kwFilter}
      ORDER BY (${list.map((_, i) => `quote ILIKE '%' || $1[${i + 1}] || '%'`).join(' OR ')}) DESC, ep
      LIMIT 60`,
    kwParams
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
