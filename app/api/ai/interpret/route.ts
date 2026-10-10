import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { yudaoRequest } from '@/lib/yudao';
import { requireSessionToken, yudaoErrorToResponse } from '../../ziwei/_session';

const MAX_CHART_SIZE = 128 * 1024;
const CONSUME_POINTS = 1;

const SYSTEM_PROMPT = `你是一位资深的紫微斗数命理分析师，师承倪海厦紫微斗数体系。
用户会提供一份机器可读的紫微命盘 JSON（十二宫的主星、辅星、四化、大限等信息）。
请基于命盘数据进行分析：
1. 简要概括命盘格局（命宫主星组合与其含义）
2. 分领域解读：性格特质、事业财运、感情婚姻、健康注意事项
3. 给出务实中肯的建议，语言亲切自然，避免宿命论式恐吓
4. 使用简体中文，用 Markdown 小标题组织内容，总长度 500-800 字
若命盘 JSON 中缺少某项信息，基于已有数据谨慎推断或明确说明信息不足。`;

interface YudaoUser {
  id: number;
}

interface YudaoPointsSummary {
  balance: number;
  totalGranted: number;
  totalConsumed: number;
}

function getAiConfig(): { client: Anthropic; model: string } | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }
  const client = new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    timeout: 120_000, // 大模型响应较慢，放宽上游超时
    maxRetries: 1,
  });
  return { client, model: process.env.AI_MODEL || 'deepseek-chat' };
}

/**
 * AI 解读：扣次数（服务端生成 bizNo 幂等）→ 调大模型 → 失败自动退还。
 * 扣/退走内部接口（X-Internal-Key 共享密钥），不对用户暴露写操作。
 */
export async function POST(req: Request) {
  const session = await requireSessionToken();
  if (session.response) {
    return session.response;
  }
  // 1. 参数校验
  let body: { chartData?: unknown; question?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  const chartData = typeof body.chartData === 'string' ? body.chartData : '';
  const question = typeof body.question === 'string' ? body.question.slice(0, 500) : '';
  if (!chartData || chartData.length > MAX_CHART_SIZE) {
    return NextResponse.json({ message: '排盘数据缺失或过大' }, { status: 400 });
  }
  try {
    JSON.parse(chartData);
  } catch {
    return NextResponse.json({ message: '排盘数据格式不正确' }, { status: 400 });
  }
  const ai = getAiConfig();
  if (!ai) {
    return NextResponse.json({ message: 'AI 解读暂未开放' }, { status: 503 });
  }
  const internalKey = process.env.ZIWEI_INTERNAL_KEY;
  if (!internalKey) {
    console.error('[ai interpret] ZIWEI_INTERNAL_KEY 未配置');
    return NextResponse.json({ message: 'AI 解读暂未开放' }, { status: 503 });
  }

  try {
    // 2. 取当前用户编号（内部接口按 userId 记账）
    const user = await yudaoRequest<YudaoUser>('/app-api/member/user/get', { token: session.token });

    // 3. 扣次数（服务端生成 bizNo，防止客户端重放/伪造）
    const bizNo = `AI-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await yudaoRequest<YudaoPointsSummary>('/app-api/ziwei/points/internal/consume', {
      method: 'POST',
      token: session.token,
      headers: { 'X-Internal-Key': internalKey },
      body: { userId: user.id, points: CONSUME_POINTS, bizNo, remark: question ? 'AI 解读（带问题）' : 'AI 解读' },
    });

    // 4. 调用大模型
    try {
      const userContent =
        `请解读以下紫微命盘：\n${chartData}` + (question ? `\n\n用户特别关心的问题：${question}` : '');
      const message = await ai.client.messages.create({
        model: ai.model,
        max_tokens: 4096,
        thinking: { type: 'disabled' }, // 推理模型的 thinking 会吃光 max_tokens 且不计入输出（实测 8192 全被思考耗尽），关闭后直接产出正文
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
      const content = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return NextResponse.json({ content, bizNo });
    } catch (e) {
      // 5. 解读失败 → 退还次数（refund 只认本人真实 CONSUME 流水，bizNo 对得上）
      console.error('[ai interpret] model call failed, refunding:', e);
      try {
        await yudaoRequest<YudaoPointsSummary>('/app-api/ziwei/points/internal/refund', {
          method: 'POST',
          token: session.token,
          headers: { 'X-Internal-Key': internalKey },
          body: { userId: user.id, bizNo, remark: 'AI 解读失败自动退款' },
        });
      } catch (refundErr) {
        console.error('[ai interpret] refund failed:', refundErr); // 退款失败需人工关注
      }
      return NextResponse.json(
        { message: 'AI 解读失败，次数已退还，请稍后重试' },
        { status: 502 }
      );
    }
  } catch (e) {
    return yudaoErrorToResponse(e);
  }
}
