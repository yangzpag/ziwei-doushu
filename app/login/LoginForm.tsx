'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, password }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || '操作失败，请重试');
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm mx-auto mt-16 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6 flex gap-2 rounded-lg bg-slate-100 p-1 text-sm font-medium">
        {(['login', 'register'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError('');
            }}
            className={`flex-1 rounded-md py-2 transition-colors ${
              mode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {m === 'login' ? '登录' : '注册'}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-slate-600">手机号</label>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={11}
            value={mobile}
            onChange={(e) => setMobile(e.target.value.trim())}
            placeholder="请输入手机号"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-900"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-600">密码</label>
          <input
            type="password"
            maxLength={16}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? '4-16 位密码' : '请输入密码'}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-900"
            required
          />
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-slate-900 py-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>
      </form>

      <p className="mt-4 text-center text-xs text-slate-400">
        注册即表示同意《服务条款》与《隐私政策》
      </p>
    </div>
  );
}
