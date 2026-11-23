'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/v2/TopBar';
import ChartGridV2 from '@/components/v2/ChartGridV2';
import AiSidePanel from '@/components/v2/AiSidePanel';
import type { ZiweiChart } from '@/lib/ziwei/types';
import s from '@/components/v2/v2.module.css';

/**
 * 保存的命盘回放页（V2）：存储 JSON 反序列化 → 六层命盘 + AI 常驻侧栏。
 */
export default function SavedChartPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [name, setName] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'notfound'>('loading');
  const [chatCollapsed, setChatCollapsed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ziwei/chart/${params.id}`, { cache: 'no-store' });
      if (res.status === 401) {
        // 会话失效：去登录后回到本页
        router.replace(`/login?next=/profile/charts/${params.id}`);
        return;
      }
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
  }, [params.id, router]);

  useEffect(() => {
    load();
  }, [load]);

  async function onDelete() {
    if (!confirm('确定删除该命盘？')) return;
    const res = await fetch(`/api/ziwei/chart/${params.id}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/profile');
    } else {
      const d = await res.json().catch(() => null);
      alert(d?.message || '删除失败，请重试');
    }
  }

  if (state === 'loading') {
    return (
      <div className={s.v2body}>
        <TopBar active="chart" />
        <div className={s.wrap} style={{ marginTop: 60, textAlign: 'center', color: 'var(--zw2-muted)' }}>
          加载中…
        </div>
      </div>
    );
  }
  if (state === 'notfound') {
    return (
      <div className={s.v2body}>
        <TopBar active="chart" />
        <div className={s.wrap} style={{ marginTop: 60, textAlign: 'center' }}>
          <p style={{ color: 'var(--zw2-ink2)' }}>命盘不存在或已删除。</p>
          <Link href="/profile" style={{ color: 'var(--zw2-gold-deep)', textDecoration: 'underline' }}>
            返回个人中心
          </Link>
        </div>
      </div>
    );
  }
  if (state === 'error' || !chart) {
    return (
      <div className={s.v2body}>
        <TopBar active="chart" />
        <div className={s.wrap} style={{ marginTop: 60, textAlign: 'center' }}>
          <p style={{ color: 'var(--zw2-ink2)' }}>加载失败，请稍后重试。</p>
          <button type="button" className={`${s.btn} ${s.btnGhost}`} style={{ marginTop: 12 }} onClick={load}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.v2body}>
      <TopBar active="chart" />
      <div className={s.wrapWide}>
        <div className={s.crumbBar}>
          <div className={s.crumb}>
            <Link href="/profile">个人中心</Link> ／ <b>命盘 · {name}</b>
            <span style={{ color: '#B8AE9C' }}>
              （{chart.yinYangGender ?? ''} · {chart.wuxingJuName}）
            </span>
          </div>
          <div className={s.acts}>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} onClick={onDelete}>
              删除命盘
            </button>
          </div>
        </div>

        <div className={`${s.main} ${chatCollapsed ? s.mainCollapsed : ''}`}>
          <ChartGridV2 chart={chart} />
          <AiSidePanel chart={chart} collapsed={chatCollapsed} onCollapse={() => setChatCollapsed(true)} />
        </div>

        {chatCollapsed && (
          <button type="button" className={s.chatFab} onClick={() => setChatCollapsed(false)}>
            ‹ AI 解读
          </button>
        )}
      </div>
    </div>
  );
}
