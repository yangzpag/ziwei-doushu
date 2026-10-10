import { NextResponse } from 'next/server';
import { yudaoRequest, YudaoError } from '@/lib/yudao';
import { getValidSession } from '@/lib/auth';

export interface MemberUser {
  id: number;
  mobile?: string;
  nickname?: string;
  avatar?: string;
}

// 查询当前登录用户（供客户端组件获取登录态）
// 语义约定：
// - 200 { user: null }          确认未登录（无会话 / token 已失效）
// - 200 { user }                已登录
// - 503 { user: null, error }   上游临时故障（网络/超时/5xx），调用方应提示重试而非跳登录
export async function GET() {
  const session = await getValidSession();
  if (session.status === 'transient_error') {
    return NextResponse.json(
      { user: null, error: 'upstream_unavailable' },
      { status: 503 }
    );
  }
  if (session.status !== 'ok') {
    return NextResponse.json({ user: null });
  }
  try {
    const user: MemberUser = await yudaoRequest('/app-api/member/user/get', {
      token: session.token,
    });
    return NextResponse.json({
      user: { id: user.id, mobile: user.mobile, nickname: user.nickname, avatar: user.avatar },
    });
  } catch (e) {
    if (e instanceof YudaoError && e.code === 401) {
      return NextResponse.json({ user: null });
    }
    console.error('[me] yudao api error:', e);
    return NextResponse.json(
      { user: null, error: 'upstream_unavailable' },
      { status: 503 }
    );
  }
}
