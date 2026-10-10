'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import LogoutButton from './LogoutButton';

interface MemberUser {
  id: number;
  mobile?: string;
  nickname?: string;
  avatar?: string;
}

function maskMobile(mobile?: string): string {
  return mobile ? mobile.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '未绑定';
}

/**
 * 个人中心：客户端组件，通过 /api/auth/me（Route Handler）获取用户信息。
 * 不在 Server Component 里做 token 刷新 —— cookie 写入只允许发生在 Route Handler 中，
 * 自动续期由 /api/auth/me 内的 getValidSession 完成。
 */
export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<MemberUser | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!res.ok) {
        setState('error'); // 服务暂不可用，不误导用户去登录
        return;
      }
      const json = await res.json();
      if (!json.user) {
        router.replace('/login?next=/profile'); // 确认未登录/会话失效
        return;
      }
      setUser(json.user);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === 'loading') {
    return <div className="mx-auto mt-16 max-w-md px-4 text-center text-slate-400">加载中…</div>;
  }
  if (state === 'error') {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-sm text-slate-600">账户服务暂时不可用</p>
        <button
          type="button"
          onClick={load}
          className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:opacity-90"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-lg font-medium text-white">
          {(user?.nickname || '用').slice(0, 1)}
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{user?.nickname || '紫微用户'}</h1>
          <p className="text-sm text-slate-500">{maskMobile(user?.mobile)}</p>
        </div>
      </div>

      <dl className="mt-6 space-y-3 text-sm">
        <div className="flex justify-between rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-slate-500">用户 ID</dt>
          <dd className="font-mono text-slate-900">{user?.id}</dd>
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
