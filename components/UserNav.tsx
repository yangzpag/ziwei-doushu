'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * 全站右上角的用户入口：
 * - 未登录 → 「登录 / 注册」
 * - 已登录 → 「个人中心」（含 AI 次数余额）
 * 各页面保持免登录可浏览，此入口保证账号体系可被发现。
 */
export default function UserNav() {
  const [state, setState] = useState<'loading' | 'guest' | 'user'>('loading');
  const [nickname, setNickname] = useState('');
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user) {
          setNickname(d.user.nickname || '我的');
          setLoggedIn();
        } else {
          setState('guest');
        }
      })
      .catch(() => setState('guest'));

    function setLoggedIn() {
      setState('user');
      fetch('/api/ziwei/points', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setBalance(typeof d?.balance === 'number' ? d.balance : null))
        .catch(() => setBalance(null));
    }
  }, []);

  const pillStyle: React.CSSProperties = {
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
  };

  if (state === 'loading') {
    return null;
  }

  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 100 }}>
      {state === 'guest' ? (
        <Link href="/login" style={pillStyle}>
          登录 / 注册
        </Link>
      ) : (
        <Link href="/profile" style={pillStyle}>
          <span>⭐</span>
          <span>个人中心</span>
          {balance !== null && (
            <span
              style={{
                background: 'rgba(255,255,255,0.2)',
                borderRadius: 999,
                padding: '1px 8px',
                fontSize: 12,
              }}
            >
              {balance}
            </span>
          )}
        </Link>
      )}
    </div>
  );
}
