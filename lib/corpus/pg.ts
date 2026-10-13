/**
 * 中医知识库语料库的 PG 连接（服务端专用）
 *
 * 与 yudao 共用一个 Neon 实例；corpus_* 表由 scripts/kb/import-corpus.mjs 维护。
 * 连接串走 DATABASE_URL（.env.local，Direct 端点）。
 */
import 'server-only';
import pg from 'pg';

const { Pool } = pg;

const globalForPg = globalThis as unknown as { __corpusPool?: pg.Pool };

function createPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未配置（中医知识库需要 PG 连接）');
  return new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

export const corpusPool: pg.Pool = globalForPg.__corpusPool ?? createPool();
if (!globalForPg.__corpusPool) globalForPg.__corpusPool = corpusPool;

export interface CorpusBook {
  id: string;
  name: string;
  short: string;
  entries: number;
  eps: number;
  eps_list: number[];
  h2_count: number;
  intro: string;
  sort_no: number;
}

export interface CorpusEntry {
  id: string;
  book_id: string;
  h2: string;
  h3: string;
  quote: string;
  bvid: string;
  ep: number;
  t_hms: string;
  score?: number;
}

/** 六部列表（按 sort_no） */
export async function listBooks(): Promise<CorpusBook[]> {
  const { rows } = await corpusPool.query<CorpusBook>(
    'SELECT id, name, short, entries, eps, eps_list, h2_count, intro, sort_no FROM corpus_book ORDER BY sort_no'
  );
  return rows;
}

export async function getBook(id: string): Promise<CorpusBook | null> {
  const { rows } = await corpusPool.query<CorpusBook>(
    'SELECT id, name, short, entries, eps, eps_list, h2_count, intro, sort_no FROM corpus_book WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

/** 库统计（首页总览） */
export async function corpusStats(): Promise<{ total: number; books: number; hours: number }> {
  const { rows } = await corpusPool.query(
    'SELECT COALESCE(SUM(entries),0)::int AS total, COUNT(*)::int AS books FROM corpus_book'
  );
  // 时长按部估算：117 集 ≈ 178 小时（语料仓库 README 口径）
  return { total: rows[0].total, books: rows[0].books, hours: 178 };
}
