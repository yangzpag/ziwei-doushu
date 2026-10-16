import { NextResponse } from 'next/server';
import { runAgent, type Emitter, type SegmentOut } from '@/lib/kb/agent';
import type { HistoryTurn } from '@/lib/kb/router';

/** POST /api/kb/ask { q, course?, history?, stream? } —— Agent 循环问答（LangChain） */
export async function POST(req: Request) {
  let body: { q?: unknown; course?: unknown; history?: unknown; stream?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  const course = typeof body.course === 'string' && body.course ? body.course : undefined;
  const stream = body.stream === true;
  const history: HistoryTurn[] = Array.isArray(body.history)
    ? body.history
        .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
        .map((h): HistoryTurn => ({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          text: String(h.text ?? '').slice(0, 4000),
          segments: Array.isArray(h.segments)
            ? (h.segments as { title?: unknown; text?: unknown }[])
                .filter((s) => s && typeof s === 'object')
                .map((s) => ({ title: String(s.title ?? ''), text: String(s.text ?? '').slice(0, 600) }))
            : undefined,
          // 佐证段落原样透传（供 agent 上下文直答与佐证展开）
          segmentsOut: Array.isArray(h.segmentsOut) ? (h.segmentsOut as SegmentOut[]) : undefined,
        }))
        .slice(-6)
    : [];
  if (!q) {
    return NextResponse.json({ message: '请输入问题' }, { status: 400 });
  }
  if (q.length > 100) {
    return NextResponse.json({ message: '问题过长' }, { status: 400 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ message: '知识库未配置' }, { status: 503 });
  }

  // ── SSE 流式模式 ──
  if (stream) {
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const em: Emitter = {
          route: (r) => send('route', r),
          delta: (t) => send('delta', { text: t }),
          note: (t) => send('note', { text: t }),
          segments: (segs) => send('segments', { segments: segs }),
          trace: (t) => send('trace', { text: t }),
          reset: () => send('reset', {}),
        };
        try {
          await runAgent(q, course, history, em);
          send('done', {});
        } catch (e) {
          console.error('[kb ask stream]', e);
          send('error', { message: '服务暂不可用，请稍后重试' });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  // ── JSON 模式（累积，供测试） ──
  const acc = {
    answer: '',
    note: '',
    segments: [] as SegmentOut[],
    route: null as { decision: string; score: number; reason: string } | null,
    trace: [] as string[],
  };
  const em: Emitter = {
    route: (r) => {
      acc.route = r;
    },
    delta: (t) => {
      acc.answer += t;
    },
    note: (t) => {
      acc.note = acc.note ? `${acc.note} ${t}` : t;
    },
    segments: (segs) => {
      acc.segments = segs;
    },
    trace: (t) => {
      acc.trace.push(t);
    },
    reset: () => {
      acc.answer = '';
    },
  };
  try {
    await runAgent(q, course, history, em);
    return NextResponse.json({
      mode: acc.route?.decision ?? 'direct',
      answer: acc.answer,
      note: acc.note || undefined,
      route: acc.route,
      segments: acc.segments,
      trace: acc.trace,
      aiAvailable: !acc.note.includes('暂不可用'),
    });
  } catch (e) {
    console.error('[kb ask]', e);
    return NextResponse.json({ message: '服务暂不可用，请稍后重试' }, { status: 503 });
  }
}
