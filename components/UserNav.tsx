'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * 用户入口（登录态感知）：
 * - 未登录 → 「登录 / 注册」
 * - 已登录 → 「个人中心」（含 AI 次数余额徽标）
 *
 * variant：
 * - 'float'（默认）：fixed 右上角悬浮，用于无自带导航的页面；首页（有自带 nav）自动不渲染
 * - 'inline'：内联胶囊，嵌入页面自带导航条（首页），style 可传入页面色板
 */
export default function UserNav({
  variant = 'float',
  style,
}: {
  variant?: 'float' | 'inline';
  style?: React.CSSProperties;
}) {
  const pathname = usePathname();
  const [state, setState] = useState<'loading' | 'guest' | 'user' | 'error'>('loading');
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    setState('loading');
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user) {
          setState('user');
          fetch('/api/ziwei/points', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((d2) => setBalance(typeof d2?.balance === 'number' ? d2.balance : null))
            .catch(() => setBalance(null));
        } else {
          setState('guest');
        }
      })
      .catch(() => setState('error')); // 上游抖动 ≠ 游客：隐藏入口（路由切换时重试），不误导已登录用户
  }, [pathname]);

  // 首页 / 排盘结果页 / 命盘回放页使用 V2 TopBar（自带用户入口），悬浮版跳过（避免重叠）
  if (
    variant === 'float' &&
    (pathname === '/' || pathname === '/chart' || pathname.startsWith('/profile/charts'))
  ) {
    return null;
  }
  if (state === 'loading' || state === 'error') {
    return null;
  }

  const baseStyle: React.CSSProperties =
    variant === 'float'
      ? {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          borderRadius: 999,
          fontSize: 13,
          textDecoration: 'none',
          background: 'rgba(0,0,0,0.35)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.25)',
          color: '#fff',
        }
      : {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          borderRadius: 999,
          fontSize: '11px',
          textDecoration: 'none',
          background: 'transparent',
          border: '1px solid currentColor',
          color: 'inherit',
          opacity: 0.9,
          ...style,
        };

  const badgeStyle: React.CSSProperties =
    variant === 'float'
      ? { background: 'rgba(255,255,255,0.2)', borderRadius: 999, padding: '1px 8px', fontSize: 12 }
      : { borderRadius: 999, padding: '0 8px', fontSize: 11, background: 'rgba(127,127,127,0.15)' };

  return (
    <div style={variant === 'float' ? { position: 'fixed', top: 16, right: 16, zIndex: 100 } : undefined}>
      {state === 'guest' ? (
        <Link href="/login" style={baseStyle}>
          登录 / 注册
        </Link>
      ) : (
        <Link href="/profile" style={baseStyle}>
          <span>个人中心</span>
          {balance !== null && <span style={badgeStyle}>{balance}</span>}
        </Link>
      )}
    </div>
  );
}
