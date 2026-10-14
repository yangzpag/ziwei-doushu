/**
 * 时间轴工具：解析 / 格式化 / B 站链接生成。
 *
 * B 站链接一律由程序依据 BV 号、分P/CID、秒数生成，禁止模型生成。
 */

/**
 * 解析 'HH:MM:SS' / 'MM:SS' / 'HH:MM:SS,mmm' / 'HH:MM:SS.mmm' / 纯数字 → 毫秒。
 *
 * 纯数字的单位启发式：< 86400 视为秒（24 小时，字幕时间不可能超过），
 * ≥ 86400 视为毫秒。小数一律按秒处理（WebVTT 惯例）。
 */
export function parseTimestampToMs(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) return Math.round(input * 1000);
    return input >= 86_400 ? input : input * 1000;
  }
  const s = input.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const v = Number(s);
    if (!Number.isInteger(v)) return Math.round(v * 1000);
    return v >= 86_400 ? v : v * 1000;
  }
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) throw new Error(`无法解析时间戳: ${input}`);
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((h * 60 + min) * 60 + sec) * 1000 + frac;
}

/** 毫秒 → 'HH:MM:SS'（语料 t_hms 同款格式） */
export function formatHms(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

export interface BiliLinkInput {
  bvid: string;
  /** 分P序号（>1 时附 p 参数） */
  part?: number;
  /** 分P CID（预留：需要精确定位分P时由调用方使用） */
  cid?: number | null;
  tMs: number;
}

/**
 * 生成 B 站链接。秒数向下取整（?t= 只接受整数秒）。
 * 分P > 1 时附带 p 参数；CID 不进入 URL（页面链接用 p 定位）。
 */
export function bilibiliUrl(input: BiliLinkInput): string {
  const { bvid, part = 1, tMs } = input;
  if (!bvid) return '';
  const t = Math.max(0, Math.floor(tMs / 1000));
  const base = `https://www.bilibili.com/video/${bvid}`;
  const params: string[] = [`t=${t}`];
  if (part > 1) params.push(`p=${part}`);
  return `${base}?${params.join('&')}`;
}
