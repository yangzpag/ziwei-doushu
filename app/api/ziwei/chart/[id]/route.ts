import { NextResponse } from 'next/server';
import { yudaoRequest } from '@/lib/yudao';
import { requireSessionToken, yudaoErrorToResponse } from '../../_session';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 命盘详情（含完整排盘 JSON，用于回放） */
export async function GET(_req: Request, { params }: RouteContext) {
  const session = await requireSessionToken();
  if (session.response) {
    return session.response;
  }
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ message: '参数错误' }, { status: 400 });
  }
  try {
    const chart = await yudaoRequest<{ id: number; name: string; chartData: string; createTime: number }>(
      `/app-api/ziwei/chart/get?id=${id}`,
      { token: session.token }
    );
    return NextResponse.json(chart);
  } catch (e) {
    return yudaoErrorToResponse(e);
  }
}

/** 删除命盘 */
export async function DELETE(_req: Request, { params }: RouteContext) {
  const session = await requireSessionToken();
  if (session.response) {
    return session.response;
  }
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ message: '参数错误' }, { status: 400 });
  }
  try {
    const result = await yudaoRequest<boolean>(`/app-api/ziwei/chart/delete?id=${id}`, {
      method: 'DELETE',
      token: session.token,
    });
    return NextResponse.json(result);
  } catch (e) {
    return yudaoErrorToResponse(e);
  }
}
