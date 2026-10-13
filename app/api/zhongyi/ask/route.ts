import { NextResponse } from 'next/server';
import { listBooks, type CorpusEntry } from '@/lib/corpus/pg';
import { searchEntries } from '@/lib/corpus/search';

/** 引用分组：与设计稿 groupHits 一致——同 (条文/主题, 类型, 集数) 归一组，最多 3 组 × 4 条 */
function groupHits(hits: CorpusEntry[], bookName: (id: string) => string) {
  const groups: { title: string; items: CorpusEntry[] }[] = [];
  const seen = new Map<string, { title: string; items: CorpusEntry[] }>();
  for (const r of hits) {
    const key = `${r.book_id}|${r.h2}|${r.h3}|${r.ep}`;
    const hit = seen.get(key);
    if (hit) {
      if (hit.items.length < 4) hit.items.push(r);
      continue;
    }
    if (groups.length >= 3) continue;
    const g = {
      title: `${bookName(r.book_id)} · ${r.h2}${r.h3 ? ' · ' + r.h3 : ''}（第 ${r.ep} 集）`,
      items: [r],
    };
    seen.set(key, g);
    groups.push(g);
  }
  return groups;
}

/** POST /api/zhongyi/ask { q, book? } —— 语义/关键词检索判语，分组返回 */
export async function POST(req: Request) {
  let body: { q?: unknown; book?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  const book = typeof body.book === 'string' && body.book ? body.book : undefined;
  if (!q) {
    return NextResponse.json({ message: '请输入问题' }, { status: 400 });
  }
  if (q.length > 100) {
    return NextResponse.json({ message: '问题过长' }, { status: 400 });
  }

  try {
    const [books, { mode, entries }] = await Promise.all([listBooks(), searchEntries(q, book)]);
    const nameOf = (id: string) => books.find((b) => b.id === id)?.name ?? id;
    const groups = groupHits(entries, nameOf);
    const foot =
      mode === 'vector'
        ? `共命中 ${entries.length} 条判语，语义匹配取最相关的三组。点出处编号展开引用，可回放倪师原视频的那一秒。`
        : `语义服务暂不可用，已按关键词命中 ${entries.length} 条判语。`;
    return NextResponse.json({ mode, groups, hits: entries.slice(0, 24), foot });
  } catch (e) {
    console.error('[zhongyi ask]', e);
    return NextResponse.json({ message: '检索失败，请稍后重试' }, { status: 503 });
  }
}
