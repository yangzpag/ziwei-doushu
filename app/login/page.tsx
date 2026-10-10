import LoginForm from './LoginForm';

export const metadata = {
  title: '登录 / 注册',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // 只允许站内路径，防跳转
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/profile';
  return <LoginForm next={target} />;
}
