import { NextResponse } from 'next/server';
import { yudaoRequest } from '@/lib/yudao';
import { clearAuthCookies, getAuth } from '@/lib/auth';

// 登出：通知 Java 侧作废 token + 清理 cookie
export async function POST() {
  const auth = await getAuth();
  if (auth) {
    try {
      await yudaoRequest('/app-api/member/auth/logout', {
        method: 'POST',
        token: auth.accessToken,
      });
    } catch {
      // Java 侧作废失败不阻塞登出，cookie 一定清掉
    }
  }
  await clearAuthCookies();
  return NextResponse.json({ ok: true });
}
