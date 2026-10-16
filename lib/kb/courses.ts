/** 课程元数据（六部，与语料 book_id 对应） */
export interface CourseMeta {
  id: string;
  name: string;
  short: string;
}

export const COURSES: CourseMeta[] = [
  { id: '01-shanghan', name: '伤寒论', short: '伤' },
  { id: '02-jinkui', name: '金匮要略', short: '金' },
  { id: '03-bencao', name: '神农本草经', short: '本' },
  { id: '04-neijing', name: '黄帝内经', short: '内' },
  { id: '05-zhongjing', name: '仲景心法', short: '仲' },
  { id: '06-zhenjiu', name: '针灸大成', short: '针' },
];

export function courseName(id: string): string {
  return COURSES.find((c) => c.id === id)?.name ?? id;
}

/** 视频秒数 → 'MM:SS' / 'H:MM:SS'。
 *  起始时间用 floor（跳转点不前移）；结束时间用 round（与用户规格示例一致：196.8 → 3:17）。
 */
export function formatSeconds(sec: number, mode: 'floor' | 'round' = 'floor'): string {
  const s = mode === 'round' ? Math.round(sec) : Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** B 站跳转链接（程序生成，带秒数） */
export function jumpUrl(bvid: string, startSeconds: number): string {
  if (!bvid) return '';
  return `https://www.bilibili.com/video/${bvid}?t=${Math.floor(startSeconds)}`;
}
