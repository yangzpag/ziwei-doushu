'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/v2/TopBar';
import ChartGridV2 from '@/components/v2/ChartGridV2';
import AiSidePanel from '@/components/v2/AiSidePanel';
import BirthForm from '@/components/BirthForm';
import { generateChart } from '@/lib/ziwei/algorithm';
import { computeLayers } from '@/lib/ziwei/layers';
import type { BirthInfo, ZiweiChart } from '@/lib/ziwei/types';
import s from '@/components/v2/v2.module.css';

const SIHUA_CHIP_CLASS: Record<string, string> = {
  禄: 'chipOLu',
  权: 'chipOQs',
  科: 'chipOKe',
  忌: 'chipOJi',
};

/**
 * 排盘结果页（V2）：顶栏 + 面包屑/操作 + 工具条 + 命盘（六层切换）+ AI 常驻侧栏。
 * 支持 ?auto=1：从 sessionStorage 读取首页表单提交的出生信息自动起盘。
 */
export default function ChartPage() {
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [chatCollapsed, setChatCollapsed] = useState(false);

  // 自动起盘（首页表单跳转 /chart?auto=1）
  useEffect(() => {
    if (!chart && new URLSearchParams(window.location.search).get('auto') === '1') {
      try {
        const raw = sessionStorage.getItem('zw-pending-birth');
        if (raw) {
          setChart(generateChart(JSON.parse(raw) as BirthInfo));
          sessionStorage.removeItem('zw-pending-birth');
        }
      } catch {
        /* 忽略坏数据 */
      }
    }
  }, [chart]);

  // 登录态
  useEffect(() => {
    if (!chart) return;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLoggedIn(Boolean(d?.user)))
      .catch(() => setLoggedIn(false));
  }, [chart]);

  const handleBirth = (info: BirthInfo) => setChart(generateChart(info));

  const handleSave = useCallback(async () => {
    if (!chart) return;
    const b = chart.birthInfo;
    const defaultName = `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')} ${b.gender === 'male' ? '男' : '女'}`;
    const name = prompt('给命盘起个名字（32 字以内）：', b.name || defaultName)?.trim();
    if (!name) return;
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
        setSaveMessage('已保存');
        return;
      }
      const d = await res.json().catch(() => null);
      setSaveState('error');
      setSaveMessage(d?.message || (res.status === 401 ? '请先登录' : '保存失败，请重试'));
    } catch {
      setSaveState('error');
      setSaveMessage('网络异常，请重试');
    }
  }, [chart]);

  // 当前流年四化（工具条 chips）
  const liunianOverlay = useMemo(() => {
    if (!chart) return [];
    const ov = computeLayers(chart, new Date()).liunian.overlay;
    return Object.entries(ov).map(([star, siHua]) => ({ star, siHua }));
  }, [chart]);

  const ganzhiLabel = useMemo(() => {
    if (!chart) return '';
    const L = computeLayers(chart, new Date()).liunian;
    return L.ganzhi ?? '';
  }, [chart]);

  return (
    <div className={s.v2body}>
      <TopBar active="chart" />

      {!chart ? (
        <div className={s.wrap} style={{ paddingTop: 40, maxWidth: 720 }}>
          <div className={s.formPanel}>
            <BirthForm onSubmit={handleBirth} tone="light" />
          </div>
        </div>
      ) : (
        <div className={s.wrapWide}>
          {/* 面包屑 + 操作 */}
          <div className={s.crumbBar}>
            <div className={s.crumb}>
              <Link href="/">首页</Link> ／ <b>命盘 · {chart.birthInfo.name || '未命名'}</b>
              <span style={{ color: '#B8AE9C' }}>（{chart.yinYangGender ?? ''} · {chart.wuxingJuName}）</span>
            </div>
            <div className={s.acts}>
              {loggedIn ? (
                <button
                  type="button"
                  className={`${s.btn} ${s.btnGhost}`}
                  disabled={saveState === 'saving' || saveState === 'saved'}
                  onClick={handleSave}
                >
                  {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '✓ 已保存' : '保存命盘'}
                </button>
              ) : (
                <Link className={`${s.btn} ${s.btnGhost}`} href="/login?next=/chart">
                  登录后可保存
                </Link>
              )}
              {saveMessage && saveState !== 'saved' && (
                <span style={{ fontSize: 12.5, color: '#B5484D', alignSelf: 'center' }}>{saveMessage}</span>
              )}
            </div>
          </div>

          {/* 工具条 */}
          <div className={s.toolbar}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--zw2-ink)' }}>
              {chart.birthInfo.name || '未命名'} 的命盘
            </span>
            <div className={s.sichua}>
              <b>{new Date().getFullYear()} 流年四化</b>
              {liunianOverlay.map((it) => (
                <span key={it.star}>
                  {it.star}
                  <i className={`${s.chip} ${s[SIHUA_CHIP_CLASS[it.siHua]]}`}>{it.siHua}</i>
                </span>
              ))}
              <span style={{ color: '#B8AE9C' }}>{ganzhiLabel}</span>
            </div>
          </div>

          {/* 主体 */}
          <div className={`${s.main} ${chatCollapsed ? s.mainCollapsed : ''}`}>
            <ChartGridV2 chart={chart} />
            <AiSidePanel
              chart={chart}
              collapsed={chatCollapsed}
              onCollapse={() => setChatCollapsed(true)}
            />
          </div>

          {chatCollapsed && (
            <button type="button" className={s.chatFab} onClick={() => setChatCollapsed(false)}>
              ‹ AI 解读
            </button>
          )}
        </div>
      )}
    </div>
  );
}
