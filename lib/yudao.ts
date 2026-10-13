// yudao-server Java API 的服务端客户端（只在 Node 服务端使用，token 不下发给浏览器 JS）
const YUDAO_API_BASE = process.env.YUDAO_API_BASE || 'http://127.0.0.1:48080';
const YUDAO_TENANT_ID = process.env.YUDAO_TENANT_ID || '1';

export interface YudaoLoginResult {
  userId: number;
  accessToken: string;
  refreshToken: string;
  expiresTime: number; // 毫秒时间戳
  openid?: string;
}

export class YudaoError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function yudaoRequest<T = any>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'tenant-id': YUDAO_TENANT_ID,
    terminal: '20', // TerminalEnum.H5
    ...(options.headers || {}),
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  const res = await fetch(`${YUDAO_API_BASE}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000), // 上游 10s 超时，避免请求无限挂起
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new YudaoError(json.code, json.msg || '请求失败');
  }
  return json.data;
}
