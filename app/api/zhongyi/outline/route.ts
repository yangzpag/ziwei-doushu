import { NextResponse } from 'next/server';
import { corpusPool } from '@/lib/corpus/pg';

/** GET /api/zhongyi/outline?book=01-shanghan —— 课程大纲（h2 主题 + 条数，自然序） */
export async function GET(req: Request) {
  const book = new URL(req.url).searchParams.get('book');
  if (!book) {
    return NextResponse.json({ message: '缺少 book 参数' }, { status: 400 });
  }
  try {
    const { rows } = await corpusPool.query<{ h2: string; n: number }>(
      `SELECT h2, COUNT(*)::int AS n
         FROM corpus_entry
        WHERE book_id = $1 AND h2 <> ''
        GROUP BY h2
        ORDER BY MIN(ep), h2`,
      [book]
    );
    return NextResponse.json({ items: rows });
  } catch (e) {
    console.error('[zhongyi outline]', e);
    return NextResponse.json({ message: '大纲加载失败' }, { status: 503 });
  }
}
