import { NextResponse } from 'next/server';
import { getValidSession } from '@/lib/auth';
import { YudaoError } from '@/lib/yudao';

/**
 * BFF 会话辅助：从 httpOnly cookie 校验会话并取 accessToken。
 * - 上游临时故障 → 503（调用方显示重试，不误导用户去登录）
 * - 未登录     → 401（调用方引导去 /login）
 */
export async function requireSessionToken(): Promise<
  { token: string; response?: undefined } | { token?: undefined; response: NextResponse }
> {
  const session = await getValidSession();
  if (session.status === 'transient_error') {
    return {
      response: NextResponse.json({ message: '服务暂不可用，请稍后重试' }, { status: 503 }),
    };
  }
  if (session.status !== 'ok' || !session.token) {
    return { response: NextResponse.json({ message: '未登录' }, { status: 401 }) };
  }
  return { token: session.token };
}

/** 把 yudaoRequest 的异常转成对前端的响应（业务错误透传 message） */
export function yudaoErrorToResponse(e: unknown): NextResponse {
  if (e instanceof YudaoError) {
    return NextResponse.json({ message: e.message, code: e.code }, { status: 400 });
  }
  console.error('[ziwei api] upstream error:', e);
  return NextResponse.json({ message: '服务暂不可用，请稍后重试' }, { status: 503 });
}
