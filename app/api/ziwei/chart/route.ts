import { NextResponse } from 'next/server';
import { yudaoRequest } from '@/lib/yudao';
import { requireSessionToken, yudaoErrorToResponse } from '../_session';

/** 保存命盘 */
export async function POST(req: Request) {
  const session = await requireSessionToken();
  if (session.response) {
    return session.response;
  }
  let body: { name?: unknown; chartData?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: '请求格式错误' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const chartData = typeof body.chartData === 'string' ? body.chartData : '';
  if (!name || name.length > 32) {
    return NextResponse.json({ message: '备注名不能为空且不超过 32 字' }, { status: 400 });
  }
  if (!chartData || chartData.length > 128 * 1024) {
    return NextResponse.json({ message: '排盘数据缺失或过大' }, { status: 400 });
  }
  try {
    // 服务端再校验一次 JSON 合法性，防止把垃圾数据存进库
    JSON.parse(chartData);
    const result = await yudaoRequest<{ id: number }>('/app-api/ziwei/chart/create', {
      method: 'POST',
      token: session.token,
      body: { name, chartData },
    });
    return NextResponse.json(result);
  } catch (e) {
    return yudaoErrorToResponse(e);
  }
}

/** 我的命盘分页 */
export async function GET(req: Request) {
  const session = await requireSessionToken();
  if (session.response) {
    return session.response;
  }
  const url = new URL(req.url);
  const pageNo = Number(url.searchParams.get('pageNo')) || 1;
  const pageSize = Math.min(Number(url.searchParams.get('pageSize')) || 20, 50);
  try {
    const page = await yudaoRequest<{ total: number; list: unknown[] }>(
      `/app-api/ziwei/chart/page?pageNo=${pageNo}&pageSize=${pageSize}`,
      { token: session.token }
    );
    return NextResponse.json(page);
  } catch (e) {
    return yudaoErrorToResponse(e);
  }
}
