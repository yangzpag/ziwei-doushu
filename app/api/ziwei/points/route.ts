import { NextResponse } from 'next/server';
import { yudaoRequest } from '@/lib/yudao';
import { requireSessionToken, yudaoErrorToResponse } from '../_session';

export interface ZiweiPointsSummary {
  balance: number;
  totalGranted: number;
  totalConsumed: number;
}

/** 查询当前用户的次数权益 */
export async function GET() {
  const session = await requireSessionToken();
  if (session.response) {
    return session.response;
  }
  try {
    const points = await yudaoRequest<ZiweiPointsSummary>('/app-api/ziwei/points/get', {
      token: session.token,
    });
    return NextResponse.json(points);
  } catch (e) {
    return yudaoErrorToResponse(e);
  }
}
