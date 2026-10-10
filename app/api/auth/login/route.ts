import { NextRequest, NextResponse } from 'next/server';
import { yudaoRequest, YudaoError } from '@/lib/yudao';
import { setAuthCookies } from '@/lib/auth';

// 登录（BFF 代理：token 只落在 httpOnly cookie，不暴露给浏览器 JS）
export async function POST(req: NextRequest) {
  let body: { mobile?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  const { mobile, password } = body;
  if (!mobile || !password) {
    return NextResponse.json({ message: '请输入手机号和密码' }, { status: 400 });
  }
  try {
    const data = await yudaoRequest('/app-api/member/auth/login', {
      method: 'POST',
      body: { mobile, password },
    });
    await setAuthCookies(data);
    return NextResponse.json({ userId: data.userId });
  } catch (e) {
    if (e instanceof YudaoError) {
      return NextResponse.json({ message: e.message }, { status: 400 });
    }
    console.error('[login] yudao api error:', e);
    return NextResponse.json({ message: '登录服务暂不可用，请稍后重试' }, { status: 502 });
  }
}
