import { NextResponse } from 'next/server';
import { yudaoRequest, YudaoError } from '@/lib/yudao';
import { getValidAccessToken } from '@/lib/auth';

export interface MemberUser {
  id: number;
  mobile?: string;
  nickname?: string;
  avatar?: string;
}

// 查询当前登录用户（供客户端组件获取登录态）
export async function GET() {
  const token = await getValidAccessToken();
  if (!token) {
    return NextResponse.json({ user: null });
  }
  try {
    const user: MemberUser = await yudaoRequest('/app-api/member/user/get', { token });
    return NextResponse.json({
      user: { id: user.id, mobile: user.mobile, nickname: user.nickname, avatar: user.avatar },
    });
  } catch (e) {
    if (e instanceof YudaoError && e.code === 401) {
      return NextResponse.json({ user: null });
    }
    console.error('[me] yudao api error:', e);
    return NextResponse.json({ user: null });
  }
}
