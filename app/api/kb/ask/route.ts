import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { routeQuery, isNoHit } from '@/lib/kb/router';
import { searchSegments } from '@/lib/kb/search';
import { courseName, formatSeconds, jumpUrl } from '@/lib/kb/courses';
import type { SegmentHit } from '@/lib/kb/search';

/** 引用段落响应体中的段落（附编号与跳转入口） */
interface SegmentOut {
  n: number;
  segment_id: string;
  title: string;
  course: string;
  time_range: string;
  jump_url: string;
  text_preview: string;
  score: number;
}

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    timeout: 15_000,
    maxRetries: 0, // 网络异常时快速失败走降级，不拖慢用户等待
  });
}

/** 提取文本；空内容视为失败（代理层可能返回 200 空 body） */
function extractText(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** 带引用的 RAG 回答：只依据给定段落，论点挂 [编号]；AI 不可用时返回 null（调用方降级） */
async function answerWithCitations(q: string, segments: SegmentHit[]): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  const passageList = segments
    .map(
      (s, i) =>
        `[${i + 1}] 《${s.title}》（${courseName(s.course_id)}，${formatSeconds(s.start_seconds)}–${formatSeconds(s.end_seconds, 'round')}）\n${s.text}`
    )
    .join('\n\n');
  try {
    const res = await client.messages.create(
      {
        model: process.env.AI_MODEL || 'deepseek-chat',
        max_tokens: 800,
        system: `你是倪海厦《人纪》课程学习助手。规则：
1. 只依据下方给出的课程段落回答，禁止使用段落之外的知识；
2. 每个论点后用 [编号] 标注依据哪个段落，没有依据的内容不要写；
3. 课程内容是讲者观点，不是已证实结论，不要绝对化表述；
4. 段落没讲到的，直接说「课程里没讲这个」；
5. 简体中文，分点组织，300-500 字。`,
        messages: [{ role: 'user', content: `问题：${q}\n\n课程段落：\n${passageList}` }],
      },
      { timeout: 15_000 }
    );
    const text = extractText(res);
    return text || null;
  } catch {
    return null;
  }
}

/** 直接回答（不查库）：通用问题/闲聊；AI 不可用时返回 null */
async function answerDirect(q: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.messages.create(
      {
        model: process.env.AI_MODEL || 'deepseek-chat',
        max_tokens: 500,
        system: `你是一个友好的助手。用户的问题与中医课程库无关，直接简洁回答即可。
如果问题涉及紫微斗数排盘，提示用户使用本站的排盘功能。简体中文，200 字以内。`,
        messages: [{ role: 'user', content: q }],
      },
      { timeout: 10_000 }
    );
    const text = extractText(res);
    return text || null;
  } catch {
    return null;
  }
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
    score: Number(s.score.toFixed(3)),
  }));
}

/** POST /api/kb/ask { q, course? } —— 路由 →（RAG 带引用回答 | 直接回答） */
export async function POST(req: Request) {
  let body: { q?: unknown; course?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  const course = typeof body.course === 'string' && body.course ? body.course : undefined;
  if (!q) {
    return NextResponse.json({ message: '请输入问题' }, { status: 400 });
  }
  if (q.length > 100) {
    return NextResponse.json({ message: '问题过长' }, { status: 400 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ message: '知识库未配置' }, { status: 503 });
  }

  try {
    // 1) 路由：查库还是直答
    const route = await routeQuery(q);

    // 2) 直答
    if (route.decision === 'direct') {
      const raw = await answerDirect(q);
      const answer =
        raw ?? '这个问题与课程库无关。当前网络暂时无法调用 AI 通用回答，你可以换个课程相关的问题（药名、方剂、症状、条文）试试。';
      return NextResponse.json({
        mode: 'direct',
        answer,
        route: { decision: route.decision, score: Number(route.score.toFixed(3)), reason: route.reason },
        segments: [],
        aiAvailable: raw !== null,
      });
    }

    // 3) RAG：检索段落
    const hits = await searchSegments(q, { databaseUrl: process.env.DATABASE_URL, courseId: course, limit: 5 });

    // 3a) 走了 RAG 但库内没有真正命中 → 明说 + 直答兜底
    if (!hits.length || isNoHit(hits[0].score)) {
      const raw = await answerDirect(q);
      const answer = raw ?? '课程库里没有找到与这个问题相关的内容。当前网络暂时无法调用 AI 通用回答。';
      return NextResponse.json({
        mode: 'direct',
        answer,
        route: { decision: 'rag', score: Number(hits[0]?.score.toFixed(3) ?? 0), reason: '路由判定需查库，但库内无足够相关内容' },
        segments: [],
        note: '课程库里没有找到相关内容。',
        aiAvailable: raw !== null,
      });
    }

    // 3b) 带引用的回答；AI 不可用 → 降级为命中段落原文拼接
    const answer = await answerWithCitations(q, hits);
    if (answer === null) {
      const fallback = hits
        .map((s, i) => `【${i + 1}】《${s.title}》（${courseName(s.course_id)} ${formatSeconds(s.start_seconds)}–${formatSeconds(s.end_seconds, 'round')}）\n${s.text}`)
        .join('\n\n');
      return NextResponse.json({
        mode: 'rag',
        answer: fallback,
        route: { decision: 'rag', score: Number(hits[0].score.toFixed(3)), reason: route.reason },
        segments: toSegmentOut(hits),
        note: 'AI 综合暂不可用（网络），以下为命中的段落原文，可点引用或回放查看视频。',
        aiAvailable: false,
      });
    }
    return NextResponse.json({
      mode: 'rag',
      answer,
      route: { decision: 'rag', score: Number(hits[0].score.toFixed(3)), reason: route.reason },
      segments: toSegmentOut(hits),
      aiAvailable: true,
    });
  } catch (e) {
    console.error('[kb ask]', e);
    return NextResponse.json({ message: '服务暂不可用，请稍后重试' }, { status: 503 });
  }
}
