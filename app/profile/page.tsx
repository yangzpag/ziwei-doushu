'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import LogoutButton from './LogoutButton';

interface MemberUser {
  id: number;
  mobile?: string;
  nickname?: string;
  avatar?: string;
}

interface ChartSummary {
  id: number;
  name: string;
  createTime: number;
}

function maskMobile(mobile?: string): string {
  return mobile ? mobile.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '未绑定';
}

/**
 * 个人中心：客户端组件。
 * - 次数余额与命盘列表经 BFF（/api/ziwei/*）读取，cookie 写入只发生在 Route Handler
 */
export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<MemberUser | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [balance, setBalance] = useState<number | null>(null);
  const [charts, setCharts] = useState<ChartSummary[] | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const meRes = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!meRes.ok) {
        setState('error'); // 服务暂不可用，不误导用户去登录
        return;
      }
      const me = await meRes.json();
      if (!me.user) {
        router.replace('/login?next=/profile'); // 确认未登录/会话失效
        return;
      }
      setUser(me.user);
      setState('ready');
      // 次数与命盘列表并行加载（失败不影响基本信息展示）
      fetch('/api/ziwei/points', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setBalance(typeof d?.balance === 'number' ? d.balance : -1))
        .catch(() => setBalance(-1));
      fetch('/api/ziwei/chart?pageNo=1&pageSize=20', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setCharts(d && Array.isArray(d.list) ? d.list : null))
        .catch(() => setCharts(null));
    } catch {
      setState('error');
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function deleteChart(id: number) {
    if (!confirm('确定删除该命盘？')) {
      return;
    }
    const res = await fetch(`/api/ziwei/chart/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setCharts((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
    } else {
      const d = await res.json().catch(() => null);
      alert(d?.message || '删除失败，请重试');
    }
  }

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
    <div className="mx-auto mt-10 w-full max-w-md px-4 pb-16">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
            <dd className="font-mono text-slate-900">
              {balance === null ? '加载中…' : balance === -1 ? '—' : balance}
            </dd>
          </div>
        </dl>

        <div className="mt-6 flex justify-end">
          <LogoutButton />
        </div>
      </div>

      <h2 className="mb-3 mt-8 text-base font-semibold text-slate-900">我的命盘</h2>
      {charts === null ? (
        <p className="text-sm text-slate-400">加载中…</p>
      ) : charts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          还没有保存过命盘。
          <Link href="/chart" className="ml-1 text-slate-900 underline underline-offset-2">
            去排盘并保存
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {charts.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm"
            >
              <div>
                <Link
                  href={`/profile/charts/${c.id}`}
                  className="font-medium text-slate-900 hover:underline underline-offset-2"
                >
                  {c.name}
                </Link>
                <p className="text-xs text-slate-400">
                  {new Date(c.createTime).toLocaleString('zh-CN')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/profile/charts/${c.id}`}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-slate-900 hover:text-slate-900"
                >
                  查看
                </Link>
                <button
                  type="button"
                  onClick={() => deleteChart(c.id)}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:border-red-500"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
