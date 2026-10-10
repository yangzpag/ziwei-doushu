import LoginForm from './LoginForm';

export const metadata = {
  title: '登录 / 注册',
};

/**
 * 解析 ?next= 跳转目标：
 * 1. 重复参数时 Next 会给数组，取第一个
 * 2. 只允许站内路径 —— 用 URL 规范化校验 origin，拦截 /\attacker.example
 *    这类反斜杠写法（浏览器会把它当 // 处理，解析到外部域）
 */
function resolveNextTarget(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('/')) {
    return '/profile';
  }
  try {
    const url = new URL(value, 'https://internal.invalid');
    return url.origin === 'https://internal.invalid'
      ? `${url.pathname}${url.search}${url.hash}`
      : '/profile';
  } catch {
    return '/profile';
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <LoginForm next={resolveNextTarget(next)} />;
}
