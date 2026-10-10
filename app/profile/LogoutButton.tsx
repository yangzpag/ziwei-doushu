'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onLogout() {
    setError(false);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        setError(true); // 登出接口异常：留在本页，可重试
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="text-right">
      {error && <p className="mb-2 text-xs text-red-600">登出失败，请重试</p>}
      <button
        type="button"
        onClick={onLogout}
        disabled={loading}
        className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition-colors hover:border-slate-900 hover:text-slate-900 disabled:opacity-50"
      >
        {loading ? '登出中…' : '退出登录'}
      </button>
    </div>
  );
}
