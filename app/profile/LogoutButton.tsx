'use client';

import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        router.replace('/');
        router.refresh();
      }}
      className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition-colors hover:border-slate-900 hover:text-slate-900"
    >
      退出登录
    </button>
  );
}
