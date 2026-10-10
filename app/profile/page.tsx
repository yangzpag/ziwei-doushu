import { redirect } from 'next/navigation';
import { getValidAccessToken } from '@/lib/auth';
import { yudaoRequest, YudaoError } from '@/lib/yudao';
import LogoutButton from './LogoutButton';

export const metadata = {
  title: '我的账户',
};

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const token = await getValidAccessToken();
  if (!token) {
    redirect('/login?next=/profile');
  }
  let user;
  try {
    user = await yudaoRequest('/app-api/member/user/get', { token });
  } catch (e) {
    // token 已被作废（登出/后台踢人），回登录页
    if (e instanceof YudaoError && e.code === 401) {
      redirect('/login?next=/profile');
    }
    throw e;
  }
  const maskedMobile = user.mobile ? user.mobile.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '未绑定';

  return (
    <div className="w-full max-w-md mx-auto mt-16 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-lg font-medium text-white">
          {(user.nickname || '用').slice(0, 1)}
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{user.nickname || '紫微用户'}</h1>
          <p className="text-sm text-slate-500">{maskedMobile}</p>
        </div>
      </div>

      <dl className="mt-6 space-y-3 text-sm">
        <div className="flex justify-between rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-slate-500">用户 ID</dt>
          <dd className="font-mono text-slate-900">{user.id}</dd>
        </div>
        <div className="flex justify-between rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-slate-500">AI 解读次数</dt>
          <dd className="font-mono text-slate-900">敬请期待</dd>
        </div>
      </dl>

      <div className="mt-6 flex justify-end">
        <LogoutButton />
      </div>
    </div>
  );
}
