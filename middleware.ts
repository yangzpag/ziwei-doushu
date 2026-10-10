import { NextRequest, NextResponse } from 'next/server';

// 需要登录的路径前缀（浏览排盘/知识库不受限）
const PROTECTED_PREFIXES = ['/profile'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    const hasAuth = req.cookies.get('ziwei_access_token');
    if (!hasAuth) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.search = `next=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/profile/:path*'],
};
