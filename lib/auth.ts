// 登录态的 cookie 管理（仅服务端 Route Handler / Server Component 使用）
import { cookies } from 'next/headers';
import { yudaoRequest, YudaoError, type YudaoLoginResult } from './yudao';

export const ACCESS_TOKEN_COOKIE = 'ziwei_access_token';
export const REFRESH_TOKEN_COOKIE = 'ziwei_refresh_token';
export const EXPIRES_TIME_COOKIE = 'ziwei_expires_time';

// cookie 生命周期与 refreshToken 有效期对齐（yudao 默认 30 天）
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 3600;

export interface AuthInfo {
  accessToken: string;
  refreshToken: string;
  expiresTime: number;
}

export async function getAuth(): Promise<AuthInfo | null> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_TOKEN_COOKIE)?.value;
  const expiresTime = Number(store.get(EXPIRES_TIME_COOKIE)?.value || 0);
  if (!accessToken || !refreshToken || !expiresTime) {
    return null;
  }
  return { accessToken, refreshToken, expiresTime };
}

export async function setAuthCookies(login: YudaoLoginResult): Promise<void> {
  const store = await cookies();
  const options = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  };
  store.set(ACCESS_TOKEN_COOKIE, login.accessToken, options);
  store.set(REFRESH_TOKEN_COOKIE, login.refreshToken, options);
  store.set(EXPIRES_TIME_COOKIE, String(login.expiresTime), options);
}

export async function clearAuthCookies(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
  store.delete(EXPIRES_TIME_COOKIE);
}

// 会话校验结果：
// ok                —— token 有效（必要时已自动续期并更新 cookie）
// unauthenticated   —— 无会话 cookie（真未登录）
// invalid           —— Yudao 明确拒绝（token/refreshToken 已作废），应视为未登录
// transient_error   —— 网络/超时等临时故障，应提示重试而不是踢去登录
export type SessionStatus = 'ok' | 'unauthenticated' | 'invalid' | 'transient_error';

export interface ValidSession {
  status: SessionStatus;
  token?: string;
}

// 校验会话并取有效 accessToken：过期则用 refreshToken 自动续期并更新 cookie
// ⚠️ 只能在 Route Handler / Server Function 中调用（内部会写 cookie，
//    Server Component 渲染期间调用会抛错）——页面需要会话时请走 /api/auth/me
export async function getValidSession(): Promise<ValidSession> {
  const auth = await getAuth();
  if (!auth) {
    return { status: 'unauthenticated' };
  }
  // 提前 1 分钟视为过期
  if (Date.now() < auth.expiresTime - 60_000) {
    return { status: 'ok', token: auth.accessToken };
  }
  try {
    const data: YudaoLoginResult = await yudaoRequest(
      `/app-api/member/auth/refresh-token?refreshToken=${encodeURIComponent(auth.refreshToken)}`,
      { method: 'POST' }
    );
    await setAuthCookies(data);
    return { status: 'ok', token: data.accessToken };
  } catch (e) {
    // Yudao 明确拒绝（token 被作废/refreshToken 失效）→ 会话无效；
    // 网络/超时等临时故障 → 上游错误，调用方应走重试而不是踢用户去登录
    if (e instanceof YudaoError) {
      return { status: 'invalid' };
    }
    return { status: 'transient_error' };
  }
}
