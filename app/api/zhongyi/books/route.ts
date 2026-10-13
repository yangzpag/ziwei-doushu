import { NextResponse } from 'next/server';
import { listBooks, corpusStats } from '@/lib/corpus/pg';

/** GET /api/zhongyi/books —— 六部列表 + 总览统计 */
export async function GET() {
  try {
    const [books, stats] = await Promise.all([listBooks(), corpusStats()]);
    return NextResponse.json({ books, stats });
  } catch (e) {
    console.error('[zhongyi books]', e);
    return NextResponse.json({ message: '知识库暂不可用' }, { status: 503 });
  }
}
