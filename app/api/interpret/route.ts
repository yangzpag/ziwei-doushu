import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { yudaoRequest } from '@/lib/yudao';
import { requireSessionToken } from '@/app/api/ziwei/_session';

const MAX_CHART_SIZE = 128 * 1024;
const MAX_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 2000;
const CONSUME_POINTS = 1;

const SYSTEM_PROMPT = `你是一位资深的紫微斗数命理分析师，师承倪海厦紫微斗数体系。
用户的命盘 JSON（十二宫主星、辅星、四化、大限等）会附在下方。
解读要求：
1. 立论必须基于命盘数据，引用具体宫位与星曜；数据缺失时明确说明并谨慎推断
2. 语言亲切自然、务实中肯，避免宿命论式恐吓，不给医疗/投资等重大决策下绝对结论
3. 使用简体中文，适当用小标题或分点组织，单次回答控制在 500-800 字

命盘数据：
`;

interface YudaoUser {
  id: number;
}

interface YudaoPointsSummary {
  balance: number;
}

function getAiConfig(): { client: Anthropic; model: string } | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }
  const client = new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    timeout: 120_000,
    maxRetries: 1,
  });
  return { client, model: process.env.AI_MODEL || 'deepseek-chat' };
}

const encoder = new TextEncoder();
const sseEvent = (deltaText: string) =>
  encoder.encode(`data: ${JSON.stringify({ delta: { text: deltaText } })}\n\n`);
const SSE_DONE = encoder.encode('data: [DONE]\n\n');

/**
 * AI 命盘对话（SSE 流式，配合开源 ChatPanel 组件）。
 * 计费：每轮提问扣 1 次（服务端生成 bizNo 幂等），模型失败自动退还。
 * 扣/退走内部接口（X-Internal-Key），不对用户暴露写操作。
 */
export async function POST(req: Request) {
  const session = await requireSessionToken();
  if (session.response) {
    return session.response;
  }
  // 1. 参数校验
  let body: { chart?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  if (typeof body.chart !== 'object' || body.chart === null) {
    return NextResponse.json({ message: '缺少命盘数据' }, { status: 400 });
  }
  const chartJson = JSON.stringify(body.chart);
  if (chartJson.length > MAX_CHART_SIZE) {
    return NextResponse.json({ message: '排盘数据过大' }, { status: 400 });
  }
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length === 0 || rawMessages.length > MAX_MESSAGES) {
    return NextResponse.json({ message: '对话轮数非法' }, { status: 400 });
  }
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of rawMessages) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ message: '对话内容非法' }, { status: 400 });
    }
    history.push({ role, content });
  }
  if (history[history.length - 1].role !== 'user') {
    return NextResponse.json({ message: '对话必须以提问结束' }, { status: 400 });
  }
  const ai = getAiConfig();
  if (!ai) {
    return NextResponse.json({ message: 'AI 解读暂未开放' }, { status: 503 });
  }
  const internalKey = process.env.ZIWEI_INTERNAL_KEY;
  if (!internalKey) {
    console.error('[ai chat] ZIWEI_INTERNAL_KEY 未配置');
    return NextResponse.json({ message: 'AI 解读暂未开放' }, { status: 503 });
  }

  try {
    // 2. 取用户编号 + 扣次数（每轮 1 次，服务端生成 bizNo 幂等）
    const user = await yudaoRequest<YudaoUser>('/app-api/member/user/get', { token: session.token });
    const bizNo = `CHAT-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await yudaoRequest<YudaoPointsSummary>('/app-api/ziwei/points/internal/consume', {
      method: 'POST',
      token: session.token,
      headers: { 'X-Internal-Key': internalKey },
      body: { userId: user.id, points: CONSUME_POINTS, bizNo, remark: 'AI 对话解读' },
    });

    // 3. 流式调用大模型，转发为 ChatPanel 约定的 SSE 格式
    const stream = ai.client.messages.stream({
      model: ai.model,
      max_tokens: 4096,
      thinking: { type: 'disabled' }, // 推理模型默认 thinking 会耗尽 max_tokens 导致无正文
      system: SYSTEM_PROMPT + chartJson,
      messages: history,
    });

    const apiStream = new ReadableStream<Uint8Array>({
      start(controller) {
        let refunded = false;
        const refund = async (reason: string) => {
          if (refunded) {
            return;
          }
          refunded = true;
          try {
            await yudaoRequest<YudaoPointsSummary>('/app-api/ziwei/points/internal/refund', {
              method: 'POST',
              token: session.token,
              headers: { 'X-Internal-Key': internalKey },
              body: { userId: user.id, bizNo, remark: reason },
            });
          } catch (e) {
            console.error('[ai chat] refund failed:', e); // 退款失败需人工关注
          }
        };

        stream.on('text', (text) => {
          try {
            controller.enqueue(sseEvent(text));
          } catch {
            // 客户端已断开，忽略
          }
        });
        stream.on('error', (e) => {
          console.error('[ai chat] stream error, refunding:', e);
          void refund('AI 对话中断自动退款');
          try {
            controller.enqueue(sseEvent('\n\n（解读中断，次数已退还，请重试）'));
            controller.enqueue(SSE_DONE);
            controller.close();
          } catch {
            // 已关闭
          }
        });
        stream.finalMessage()
          .then(() => {
            try {
              controller.enqueue(SSE_DONE);
              controller.close();
            } catch {
              // 已关闭
            }
          })
          .catch(async (e) => {
            console.error('[ai chat] finalMessage error, refunding:', e);
            await refund('AI 对话失败自动退款');
            try {
              controller.enqueue(sseEvent('\n\n（解读失败，次数已退还，请重试）'));
              controller.enqueue(SSE_DONE);
              controller.close();
            } catch {
              // 已关闭
            }
          });
      },
    });

    return new Response(apiStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (e) {
    // 扣费前/扣费环节的失败：透传语义（含余额不足）
    if (e instanceof Error && e.message.includes('次数不足')) {
      return NextResponse.json({ message: e.message }, { status: 400 });
    }
    return NextResponse.json({ message: 'AI 解读暂不可用，请稍后重试' }, { status: 502 });
  }
}
