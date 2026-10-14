import { NextResponse } from 'next/server';
import { listBooks, type CorpusEntry } from '@/lib/corpus/pg';
import { searchEntries } from '@/lib/corpus/search';
import { rewriteQuery, type HistoryTurn } from '@/lib/corpus/rewrite';

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

/** POST /api/zhongyi/ask { q, book?, history? } —— 追问改写 + 混合检索 + 分组 */
export async function POST(req: Request) {
  let body: { q?: unknown; book?: unknown; history?: unknown };
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
  // 最近对话（用于追问指代补全）；只取role与text，截断防滥用
  const history: HistoryTurn[] = Array.isArray(body.history)
    ? body.history
        .filter((h): h is { role: unknown; text: unknown } => !!h && typeof h === 'object')
        .map((h): HistoryTurn => ({
          role: h.role === 'user' ? 'user' : 'ai',
          text: String(h.text ?? '').slice(0, 200),
        }))
        .slice(-6)
    : [];

  try {
    // 1. 追问改写（补全指代 + 识别原文意图）；失败静默降级为原问题
    const { query: rewritten, wantsOriginal } = await rewriteQuery(q, history);
    // 2. 混合检索（向量 ∪ 关键词）
    const [books, { mode, entries }] = await Promise.all([
      listBooks(),
      searchEntries(rewritten, book),
    ]);
    const nameOf = (id: string) => books.find((b) => b.id === id)?.name ?? id;
    const groups = groupHits(entries, nameOf);
    const foot =
      mode === 'vector'
        ? `共命中 ${entries.length} 条判语，语义匹配取最相关的三组。点出处编号展开引用，可回放倪师原视频的那一秒。`
        : `语义服务暂不可用，已按关键词命中 ${entries.length} 条判语。`;
    return NextResponse.json({
      mode,
      groups,
      hits: entries.slice(0, 24),
      foot,
      rewritten: rewritten !== q ? rewritten : undefined,
      wantsOriginal,
    });
  } catch (e) {
    console.error('[zhongyi ask]', e);
    return NextResponse.json({ message: '检索失败，请稍后重试' }, { status: 503 });
  }
}
