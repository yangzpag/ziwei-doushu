import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { routeQuery, isNoHit, type HistoryTurn } from '@/lib/kb/router';
import { searchSegments } from '@/lib/kb/search';
import { courseName, formatSeconds, jumpUrl } from '@/lib/kb/courses';
import type { SegmentHit } from '@/lib/kb/search';

/** 佐证段落（响应体中的段落：附编号、跳转入口；text 供追问直答复用） */
export interface SegmentOut {
  n: number;
  segment_id: string;
  title: string;
  course: string;
  time_range: string;
  jump_url: string;
  text_preview: string;
  text: string;
  score: number;
}

interface RouteInfo {
  decision: string;
  score: number;
  reason: string;
}

/** 统一出口：JSON 模式累积、SSE 模式转发 */
interface Emitter {
  route(r: RouteInfo): void;
  delta(text: string): void;
  note(text: string): void;
  segments(segs: SegmentOut[]): void;
}

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    timeout: 20_000,
    maxRetries: 0, // 网络异常时快速失败走降级，不拖慢用户等待
  });
}

function extractText(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

interface NormSeg {
  title: string;
  course: string;
  time_range: string;
  text: string;
}

/** 流式生成（AI 可用时逐字转发；不可用/失败返回 null，调用方降级） */
async function streamAnswer(
  system: string,
  user: string,
  maxTokens: number,
  em: Emitter
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const stream = client.messages.stream(
      {
        model: process.env.AI_MODEL || 'deepseek-chat',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { timeout: 30_000 }
    );
    let full = '';
    stream.on('text', (t) => {
      full += t;
      em.delta(t);
    });
    const final = await stream.finalMessage();
    const text = extractText(final);
    return text || (full.trim() ? full.trim() : null);
  } catch {
    return null;
  }
}

/** 带引用的回答：只依据给定段落，论点挂 [编号]（RAG 与追问直答共用） */
async function answerWithCitations(q: string, segments: NormSeg[], em: Emitter): Promise<string | null> {
  if (!segments.length) return null;
  const passageList = segments
    .map((s, i) => `[${i + 1}] 《${s.title}》（${s.course}，${s.time_range}）\n${s.text}`)
    .join('\n\n');
  return streamAnswer(
    `你是倪海厦《人纪》课程学习助手。规则：
1. 只依据下方给出的课程段落回答，禁止使用段落之外的知识；
2. 每个论点后用 [编号] 标注依据哪个段落，没有依据的内容不要写；
3. 课程内容是讲者观点，不是已证实结论，不要绝对化表述；
4. 段落没讲到的，直接说「课程里没讲这个」；
5. 简体中文，分点组织，300-500 字。`,
    `问题：${q}\n\n课程段落：\n${passageList}`,
    800,
    em
  );
}

/** 直接回答（不查库）：通用问题/闲聊 */
async function answerDirect(q: string, em: Emitter): Promise<string | null> {
  return streamAnswer(
    `你是一个友好的助手。用户的问题与中医课程库无关，直接简洁回答即可。
如果问题涉及紫微斗数排盘，提示用户使用本站的排盘功能。简体中文，200 字以内。`,
    q,
    500,
    em
  );
}

function toSegmentOut(segments: SegmentHit[]): SegmentOut[] {
  return segments.map((s, i) => ({
    n: i + 1,
    segment_id: s.segment_id,
    title: s.title,
    course: courseName(s.course_id),
    time_range: `${formatSeconds(s.start_seconds)}–${formatSeconds(s.end_seconds, 'round')}`,
    jump_url: jumpUrl(s.bvid, s.start_seconds),
    text_preview: s.text.slice(0, 120),
    text: s.text.slice(0, 600),
    score: Number(s.score.toFixed(3)),
  }));
}

/** 追问直答素材：历史上最近一轮带段落的 assistant 消息（按原顺序重编号） */
function collectContextSegments(history: HistoryTurn[]): SegmentOut[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role === 'assistant' && h.segments?.length) {
      return (h.segments as unknown as SegmentOut[]).map((s, idx) => ({ ...s, n: idx + 1 }));
    }
  }
  return [];
}

const DIRECT_FALLBACK = '这个问题与课程库无关。当前网络暂时无法调用 AI 通用回答，你可以换个课程相关的问题（药名、方剂、症状、条文）试试。';
const NOHIT_FALLBACK = '课程库里没有找到与这个问题相关的内容。当前网络暂时无法调用 AI 通用回答。';

/** 核心流程：路由 →（追问直答 | 检索带引用 | 直接回答），经 Emitter 输出 */
async function runAsk(q: string, course: string | undefined, history: HistoryTurn[], em: Emitter): Promise<void> {
  const route = await routeQuery(q, history);
  em.route({ decision: route.decision, score: Number(route.score.toFixed(3)), reason: route.reason });

  // 1) 追问直答：实体已在上下文段落中 → 用上下文回答，不检索
  if (route.decision === 'context') {
    const ctxSegs = collectContextSegments(history);
    const answer = await answerWithCitations(q, ctxSegs.map((s) => ({ title: s.title, course: s.course, time_range: s.time_range, text: s.text })), em);
    if (answer === null) {
      em.note('AI 综合暂不可用（网络），以下为上下文段落原文。');
      em.delta(ctxSegs.map((s, i) => `【${i + 1}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
    }
    em.segments(ctxSegs);
    return;
  }

  // 2) 直接回答
  if (route.decision === 'direct') {
    const answer = await answerDirect(q, em);
    if (answer === null) {
      em.note('AI 暂不可用（网络）。');
      em.delta(DIRECT_FALLBACK);
    }
    em.segments([]);
    return;
  }

  // 3) RAG：检索段落
  const hits = await searchSegments(q, { databaseUrl: process.env.DATABASE_URL!, courseId: course, limit: 5 });

  // 3a) 走了 RAG 但库内没有真正命中 → 明说 + 直答兜底
  if (!hits.length || isNoHit(hits[0].score)) {
    em.note('课程库里没有找到相关内容。');
    const answer = await answerDirect(q, em);
    if (answer === null) em.delta(NOHIT_FALLBACK);
    em.segments([]);
    return;
  }

  // 3b) 带引用的回答；AI 不可用 → 降级为命中段落原文拼接
  const segs = toSegmentOut(hits);
  const answer = await answerWithCitations(q, segs.map((s) => ({ title: s.title, course: s.course, time_range: s.time_range, text: s.text })), em);
  if (answer === null) {
    em.note('AI 综合暂不可用（网络），以下为命中的段落原文，可点引用或回放查看视频。');
    em.delta(segs.map((s) => `【${s.n}】《${s.title}》（${s.course} ${s.time_range}）\n${s.text}`).join('\n\n'));
  }
  em.segments(segs);
}

/** POST /api/kb/ask { q, course?, history?, stream? } */
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
        };
        try {
          await runAsk(q, course, history, em);
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

  // ── JSON 模式（累积，供测试/降级） ──
  const acc = { answer: '', note: '', segments: [] as SegmentOut[], route: null as RouteInfo | null };
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
  };
  try {
    await runAsk(q, course, history, em);
    return NextResponse.json({
      mode: acc.route?.decision ?? 'direct',
      answer: acc.answer,
      note: acc.note || undefined,
      route: acc.route,
      segments: acc.segments,
      aiAvailable: !acc.note.includes('暂不可用'),
    });
  } catch (e) {
    console.error('[kb ask]', e);
    return NextResponse.json({ message: '服务暂不可用，请稍后重试' }, { status: 503 });
  }
}
