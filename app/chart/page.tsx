'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import BirthForm from '@/components/BirthForm';
import ChartBoard from '@/components/ChartBoard';
import InsightPanel from '@/components/InsightPanel';
import TimeNav, { type TimeView } from '@/components/TimeNav';
import { generateChart } from '@/lib/ziwei/algorithm';
import type { BirthInfo, ZiweiChart, Palace } from '@/lib/ziwei/types';

/**
 * 命盘页 —— 开源版「排盘引擎 Demo」
 *
 * 这是一个最小可运行示例：用本仓库的排盘引擎 generateChart() 配合基础 UI
 * 组件，渲染一张完整紫微命盘 + 基础解读，并支持本命 / 大限 / 流年切换。
 *
 * 登录用户可保存命盘（存到个人中心，见 /profile）。
 */
export default function ChartPage() {
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [selectedPalace, setSelectedPalace] = useState<Palace | null>(null);
  const [view, setView] = useState<TimeView>('mingpan');
  const [liunianYear, setLiunianYear] = useState(() => new Date().getFullYear());
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');

  // 起盘后检查登录态，决定是否展示保存按钮
  useEffect(() => {
    if (!chart) {
      setLoggedIn(null);
      return;
    }
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLoggedIn(Boolean(d?.user)))
      .catch(() => setLoggedIn(false));
  }, [chart]);

  const handleSave = useCallback(async () => {
    if (!chart) {
      return;
    }
    const b = chart.birthInfo;
    const defaultName = `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')} ${b.gender === 'male' ? '男' : '女'}`;
    const name = prompt('给命盘起个名字（32 字以内）：', defaultName)?.trim();
    if (!name) {
      return;
    }
    setSaveState('saving');
    setSaveMessage('');
    try {
      const res = await fetch('/api/ziwei/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, chartData: JSON.stringify(chart) }),
      });
      if (res.ok) {
        setSaveState('saved');
        setSaveMessage('已保存，可在个人中心查看');
        return;
      }
      const d = await res.json().catch(() => null);
      if (res.status === 401) {
        setSaveMessage('请先登录');
        return;
      }
      setSaveState('error');
      setSaveMessage(d?.message || '保存失败，请重试');
    } catch {
      setSaveState('error');
      setSaveMessage('网络异常，请重试');
    }
  }, [chart]);

  // ── 未起盘：展示出生信息表单 ──
  if (!chart) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 20px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>紫微斗数排盘</h1>
        <p style={{ color: '#888', marginBottom: 32, fontSize: 14, lineHeight: 1.7 }}>
          输入出生年月日时，开源排盘引擎即时生成命盘。
          <br />
          （本页为引擎 Demo，完整商业版界面不在开源范围；排盘内核完全开放。）
        </p>
        <BirthForm onSubmit={(info: BirthInfo) => setChart(generateChart(info))} />
      </main>
    );
  }

  // ── 已起盘：命盘 + 解读 ──
  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <button
        type="button"
        onClick={() => { setChart(null); setSelectedPalace(null); setSaveState('idle'); }}
        style={{
          marginBottom: 16, padding: '6px 14px', cursor: 'pointer',
          border: '1px solid #ccc', borderRadius: 8, background: 'transparent',
        }}
      >
        ← 重新起盘
      </button>

      {/* ── 保存命盘 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        {loggedIn === null ? null : loggedIn ? (
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveState === 'saving' || saveState === 'saved'}
              style={{
                padding: '6px 14px', cursor: saveState === 'saving' ? 'wait' : 'pointer',
                border: '1px solid #111', borderRadius: 8, background: '#111',
                color: '#fff', fontSize: 14,
              }}
            >
              {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '✓ 已保存' : '保存命盘'}
            </button>
            {saveMessage && (
              <span style={{ fontSize: 13, color: saveState === 'error' ? '#dc2626' : '#16a34a' }}>
                {saveMessage === '请先登录' ? (
                  <Link href="/login?next=/chart" style={{ color: '#111', textDecoration: 'underline' }}>
                    请先登录
                  </Link>
                ) : (
                  saveMessage
                )}
              </span>
            )}
          </>
        ) : (
          <span style={{ fontSize: 13, color: '#888' }}>
            <Link href="/login?next=/chart" style={{ color: '#111', textDecoration: 'underline' }}>
              登录
            </Link>
            后可保存命盘到个人中心
          </span>
        )}
      </div>

      <TimeNav
        chart={chart}
        view={view}
        liunianYear={liunianYear}
        onViewChange={setView}
        onYearChange={setLiunianYear}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)',
          gap: 20, marginTop: 16, alignItems: 'start',
        }}
      >
        <ChartBoard chart={chart} onPalaceSelect={setSelectedPalace} />
        <InsightPanel chart={chart} selectedPalace={selectedPalace} />
      </div>
    </main>
  );
}
