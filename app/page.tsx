'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import TopBar from '@/components/v2/TopBar';
import SampleChart from '@/components/v2/SampleChart';
import BirthForm from '@/components/BirthForm';
import type { BirthInfo } from '@/lib/ziwei/types';
import s from '@/components/v2/v2.module.css';

interface RecentChart {
  id: number;
  name: string;
  createTime: number;
}

const MODULES = [
  {
    key: 'chart',
    title: '命盘推理',
    badge: '已上线',
    live: true,
    desc: '紫微斗数排盘已开放，输入出生时间即得十二宫命盘。AI 答疑与天纪、地纪、人纪学习模块陆续接入。',
    go: '进入排盘 →',
  },
  {
    key: 'tcm',
    title: '中医知识库',
    badge: '建设中',
    live: false,
    desc: '经典条文、方剂与经络知识的结构化检索；与命盘健康相关宫位联动，便于对照学习。',
    go: '敬请期待',
  },
  {
    key: 'meridian',
    title: '3D 人体经络',
    badge: '建设中',
    live: false,
    desc: '在可旋转的 3D 人体模型上查看十四经脉循行与常用腧穴定位，支持按经检索。',
    go: '敬请期待',
  },
];

export default function HomePage() {
  const router = useRouter();
  const [state, setState] = useState<'loading' | 'guest' | 'user'>('loading');
  const [recent, setRecent] = useState<RecentChart[]>([]);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user) {
          setState('user');
          fetch('/api/ziwei/chart?pageNo=1&pageSize=2', { cache: 'no-store' })
            .then((r2) => (r2.ok ? r2.json() : null))
            .then((d2) => setRecent(d2?.list ?? []))
            .catch(() => setRecent([]));
        } else {
          setState('guest');
        }
      })
      .catch(() => setState('guest'));
  }, []);

  // 起盘：交给结果页（/chart）渲染
  const handleBirth = (info: BirthInfo) => {
    try {
      sessionStorage.setItem('zw-pending-birth', JSON.stringify(info));
    } catch {
      /* ignore */
    }
    router.push('/chart?auto=1');
  };

  return (
    <div className={s.v2body}>
      <TopBar active="chart" />

      {/* Hero：表单 + 示例命盘 */}
      <section className={`${s.wrap} ${s.hero}`}>
        <div className={s.heroHead}>
          <p className={s.eyebrow}>命盘推理 · 紫微斗数</p>
          <h1 className={s.h1}>紫微斗数排盘</h1>
          <p className={s.sub}>输入出生时间，排出十二宫命盘；星曜、四化与宫位，逐层解读。</p>
        </div>

        <div className={s.formPanel}>
          <BirthForm onSubmit={handleBirth} tone="light" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, width: '100%' }}>
          <SampleChart />
          <p className={s.formNote} style={{ justifyContent: 'center' }}>示意数据 · 甲干四化：廉禄 破权 武科 阳忌</p>
        </div>
      </section>

      {/* 已登录：最近的命盘 */}
      {state === 'user' && recent.length > 0 && (
        <section className={`${s.wrap} ${s.recent}`}>
          <div className={s.recentHead}>
            <h3>最近的命盘</h3>
            <Link href="/profile" style={{ fontSize: 13, color: 'var(--zw2-gold)' }}>
              查看全部 →
            </Link>
          </div>
          <div className={s.recentCards}>
            {recent.map((c) => (
              <Link key={c.id} href={`/profile/charts/${c.id}`} className={s.rcard}>
                <div>
                  <div className={s.rcardT}>{c.name}</div>
                  <div className={s.rcardD}>保存于 {new Date(c.createTime).toLocaleString('zh-CN')}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 三大板块 */}
      <section className={`${s.wrap} ${s.modules}`}>
        <div className={s.secHead}>
          <h2>三大板块</h2>
          <p>从命理到中医，同一套知识底座，逐步开放。</p>
        </div>
        <div className={s.cards}>
          {MODULES.map((m) => (
            <div key={m.key} className={s.v2card} onClick={() => m.live && router.push('/chart')}>
              <div className={s.cardIc}>
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <circle cx="11" cy="11" r="8.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M11 4v14M4 11h14M6.3 6.3l9.4 9.4M15.7 6.3l-9.4 9.4" stroke="currentColor" strokeWidth="0.8" opacity=".6" />
                  <circle cx="11" cy="11" r="2" fill="currentColor" />
                </svg>
              </div>
              <h3 className={s.cardH3}>
                {m.title}
                <span className={`${s.badge} ${m.live ? s.badgeLive : s.badgeWip}`}>{m.badge}</span>
              </h3>
              <p className={s.cardP}>{m.desc}</p>
              <span className={s.cardGo} style={m.live ? undefined : { opacity: 0.45 }}>
                {m.go}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 页脚 */}
      <footer className={s.footer}>
        <div className={`${s.wrap} ${s.footInner}`}>
          <span>紫微命盘 · 命理与中医知识平台</span>
          <div className={s.footLinks}>
            <Link href="/terms">使用条款</Link>
            <Link href="/privacy">隐私条款</Link>
            {state === 'guest' && <Link href="/login">登录 / 注册</Link>}
          </div>
        </div>
      </footer>
    </div>
  );
}
