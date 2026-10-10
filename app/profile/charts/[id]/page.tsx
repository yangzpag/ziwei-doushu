'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import ChartBoard from '@/components/ChartBoard';
import ChatPanel from '@/components/ChatPanel';
import type { ZiweiChart } from '@/lib/ziwei/types';

/**
 * 保存的命盘回放页：从 BFF 取回存储的排盘 JSON，反序列化后用 ChartBoard 渲染。
 */
export default function SavedChartPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [name, setName] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'notfound'>('loading');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ziwei/chart/${params.id}`, { cache: 'no-store' });
      if (res.status === 400) {
        setState('notfound');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      const detail = await res.json();
      setChart(JSON.parse(detail.chartData));
      setName(detail.name);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function onDelete() {
    if (!confirm('确定删除该命盘？')) {
      return;
    }
    const res = await fetch(`/api/ziwei/chart/${params.id}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/profile');
    } else {
      const d = await res.json().catch(() => null);
      alert(d?.message || '删除失败，请重试');
    }
  }

  if (state === 'loading') {
    return <div className="mx-auto mt-16 max-w-md px-4 text-center text-slate-400">加载中…</div>;
  }
  if (state === 'notfound') {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
        命盘不存在或已删除。
        <div className="mt-4">
          <Link href="/profile" className="text-slate-900 underline underline-offset-2">
            返回个人中心
          </Link>
        </div>
      </div>
    );
  }
  if (state === 'error' || !chart) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
        加载失败，请稍后重试。
        <div className="mt-4">
          <button
            type="button"
            onClick={load}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:opacity-90"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>{name}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onDelete}
            style={{
              padding: '6px 14px', border: '1px solid #fca5a5', borderRadius: 8,
              background: 'transparent', color: '#dc2626', fontSize: 14, cursor: 'pointer',
            }}
          >
            删除
          </button>
          <Link
            href="/profile"
            style={{
              padding: '6px 14px', border: '1px solid #ccc', borderRadius: 8,
              background: 'transparent', textDecoration: 'none', color: '#333', fontSize: 14,
            }}
          >
            ← 返回个人中心
          </Link>
        </div>
      </div>
      <ChartBoard chart={chart} />

      {/* ── AI 对话解读（每轮消耗 1 次）── */}
      <section style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>AI 对话解读</h2>
          <span style={{ fontSize: 12, color: '#888' }}>每次提问消耗 1 次 AI 解读次数</span>
        </div>
        <div style={{ height: 560 }}>
          <ChatPanel chart={chart} />
        </div>
      </section>
    </main>
  );
}
