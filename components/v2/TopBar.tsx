'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import s from './v2.module.css';

/**
 * V2 顶栏：品牌 + 板块导航 + 登录态（未登录：登录/免费注册；已登录：头像菜单）。
 * 设计稿《首页改版设计稿》/《排盘结果页设计稿》共用。
 */
export default function TopBar({ active = 'chart' }: { active?: 'chart' | 'tcm' | 'meridian' }) {
  const router = useRouter();
  const [state, setState] = useState<'loading' | 'guest' | 'user'>('loading');
  const [nickname, setNickname] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user) {
          setNickname(d.user.nickname || '用户');
          setState('user');
        } else {
          setState('guest');
        }
      })
      .catch(() => setState('guest'));
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  return (
    <header className={s.topbar}>
      <div className={`${s.wrap} ${s.barInner}`}>
        <Link className={s.brand} href="/">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
            <circle cx="13" cy="13" r="11.5" stroke="#9C7A2E" strokeWidth="1.4" />
            <path d="M13 3v20M3 13h20M6 6l14 14M20 6L6 20" stroke="#9C7A2E" strokeWidth="0.7" opacity="0.55" />
            <circle cx="13" cy="13" r="3" fill="#9C7A2E" />
          </svg>
          紫微命盘
        </Link>

        <nav className={s.tabs}>
          <Link className={`${s.tab} ${active === 'chart' ? s.tabActive : ''}`} href="/">
            命盘推理
          </Link>
          <Link className={`${s.tab} ${active === 'tcm' ? s.tabActive : ''}`} href="/zhongyi">
            中医知识库
          </Link>
          <span className={s.tab}>3D 人体经络</span>
        </nav>

        <div className={s.barRight}>
          {state === 'loading' ? null : state === 'guest' ? (
            <>
              <Link className={s.linkBtn} href="/login">
                登录
              </Link>
              <Link className={`${s.btn} ${s.btnSolid}`} href="/login">
                免费注册
              </Link>
            </>
          ) : (
            <div className={s.avatarWrap} ref={wrapRef}>
              <button
                type="button"
                className={s.avatarBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
              >
                <div className={s.avatar}>{nickname.slice(0, 1)}</div>
                <span className={s.avatarName}>{nickname}</span>
                <span className={s.caret} />
              </button>
              {menuOpen && (
                <div className={s.menu}>
                  <Link href="/profile" onClick={() => setMenuOpen(false)}>
                    我的命盘
                  </Link>
                  <Link href="/profile" onClick={() => setMenuOpen(false)}>
                    排盘记录
                  </Link>
                  <div className={s.menuSep} />
                  <a
                    href="#"
                    style={{ color: '#A3543C' }}
                    onClick={(e) => {
                      e.preventDefault();
                      fetch('/api/auth/logout', { method: 'POST' }).then(() => {
                        // 登出后刷新服务端组件与自身登录态，避免头像/入口仍显示已登录
                        router.push('/');
                        router.refresh();
                      });
                    }}
                  >
                    退出登录
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
