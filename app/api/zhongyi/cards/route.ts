import { NextResponse } from 'next/server';
import { searchCards } from '@/lib/vk/search';
import { formatHms } from '@/lib/vk/timeline';
import { bookMeta } from '@/lib/corpus/books';

/** POST /api/zhongyi/cards { q, course?, limit? } —— 知识卡片检索（vk 流水线产物）
 *
 * 与 /api/zhongyi/ask（判语直检）互补：返回完整知识卡片（标题/摘要/整理文本/
 * 关键词/要点依据），B 站出处链接由程序生成。embed-server 不可用时自动降级关键词。
 */
export async function POST(req: Request) {
  let body: { q?: unknown; course?: unknown; limit?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  const course = typeof body.course === 'string' && body.course ? body.course : undefined;
  const limit =
    typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.min(Math.max(Math.round(body.limit), 1), 10)
      : 5;
  if (!q) {
    return NextResponse.json({ message: '请输入问题' }, { status: 400 });
  }
  if (q.length > 100) {
    return NextResponse.json({ message: '问题过长' }, { status: 400 });
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json({ message: '知识卡片索引未配置' }, { status: 503 });
  }

  try {
    const { mode, hits } = await searchCards(q, { databaseUrl, courseId: course, limit });
    return NextResponse.json({
      mode,
      cards: hits.map((h) => {
        const c = h.card;
        const meta = bookMeta(c.courseId);
        return {
          id: c.id,
          courseId: c.courseId,
          courseName: meta?.name ?? c.courseId,
          chapter: c.chapter,
          title: c.title,
          summary: c.summary,
          body: c.body,
          keywords: c.keywords,
          tStartHms: formatHms(c.tStartMs),
          tEndHms: c.tEndMs === null ? null : formatHms(c.tEndMs),
          url: h.url,
          quality: c.quality,
          completeness: c.completeness,
          genMode: c.genMode,
          evidenceCount: c.evIds.length,
        };
      }),
      foot:
        mode === 'vector'
          ? '命中知识卡片（含整理段落与视频出处），点回放跳到原视频那一秒。'
          : '语义服务暂不可用，已按关键词命中知识卡片。',
    });
  } catch (e) {
    console.error('[zhongyi cards]', e);
    return NextResponse.json({ message: '检索失败，请稍后重试' }, { status: 503 });
  }
}
