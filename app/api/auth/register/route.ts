import { NextRequest, NextResponse } from 'next/server';
import { yudaoRequest, YudaoError } from '@/lib/yudao';
import { setAuthCookies } from '@/lib/auth';

// 注册（手机号+密码，注册即登录）
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
  if (!/^1\d{10}$/.test(mobile)) {
    return NextResponse.json({ message: '手机号格式不正确' }, { status: 400 });
  }
  if (password.length < 4 || password.length > 16) {
    return NextResponse.json({ message: '密码长度为 4-16 位' }, { status: 400 });
  }
  try {
    const data = await yudaoRequest('/app-api/member/auth/register', {
      method: 'POST',
      body: { mobile, password },
    });
    await setAuthCookies(data);
    return NextResponse.json({ userId: data.userId });
  } catch (e) {
    if (e instanceof YudaoError) {
      return NextResponse.json({ message: e.message }, { status: 400 });
    }
    console.error('[register] yudao api error:', e);
    return NextResponse.json({ message: '注册服务暂不可用，请稍后重试' }, { status: 502 });
  }
}
