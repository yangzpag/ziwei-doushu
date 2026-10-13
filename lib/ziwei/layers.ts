import { Solar } from 'lunar-javascript';
import { STEMS, BRANCHES } from './constants';
import { buildStarSiHuaMap, getYearStemIndex } from './sihua';
import type { ZiweiChart } from './types';

/**
 * 六层推演（本命 / 大限 / 流年 / 流月 / 流日 / 流时）
 *
 * 各层锚点与四化均为真实历法推导：
 * - 大限：chart.daXians 按当前虚岁定位
 * - 流年：公历年干 → 四化
 * - 流月：斗君法定位流月正月宫（流年支起正月顺数至生月、逆数至生时），
 *         月干随农历月（lunar-javascript）
 * - 流日：流月宫起初一顺数至农历日；日干支取自 lunar-javascript
 * - 流时：流日宫起子时顺数至生时支；时干由日干五鼠遁
 */

export interface LayerInfo {
  /** 该层命宫所在地支索引（0=子…11=亥） */
  anchorBranch: number;
  /** 该层干支标签，如 "丙午"（本命层为 null） */
  ganzhi: string | null;
  /** 该层四化：星名 → 禄/权/科/忌 */
  overlay: Record<string, string>;
}

export interface SixLayers {
  benming: LayerInfo | null;
  daxian: LayerInfo | null;
  liunian: LayerInfo;
  liuyue: LayerInfo;
  liuri: LayerInfo;
  liushi: LayerInfo;
}

export const LAYER_META = [
  { key: 'benming', label: '本命', prefix: null, color: '#9C7A2E', tint: '#F7EFDA', tintTri: '#FBF6E7' },
  { key: 'daxian', label: '大限', prefix: '运', color: '#7B5AA6', tint: '#F1EBFA', tintTri: '#F8F5FC' },
  { key: 'liunian', label: '流年', prefix: '年', color: '#C87D2F', tint: '#FAEDDC', tintTri: '#FCF5EB' },
  { key: 'liuyue', label: '流月', prefix: '月', color: '#3F7D4E', tint: '#E9F2E7', tintTri: '#F3F8F2' },
  { key: 'liuri', label: '流日', prefix: '日', color: '#2E8C8C', tint: '#E4F1F1', tintTri: '#F1F8F8' },
  { key: 'liushi', label: '流时', prefix: '时', color: '#3A6EA5', tint: '#E9EFF8', tintTri: '#F3F7FB' },
] as const;

const mod12 = (n: number) => ((n % 12) + 12) % 12;

/** 五鼠遁：日干索引 → 子时天干索引（甲己日起甲子） */
function hourStemIndex(dayStemIdx: number, hourBranchIdx: number): number {
  return mod10((dayStemIdx % 5) * 2 + hourBranchIdx);
}
const mod10 = (n: number) => ((n % 10) + 10) % 10;

/**
 * 计算六层信息。
 * @param chart 排盘结果
 * @param date  当前选中时刻（驱动 流年/流月/流日/流时）
 */
export function computeLayers(chart: ZiweiChart, date: Date): SixLayers {
  // ── 本命 ──
  const benming: LayerInfo | null = {
    anchorBranch: chart.mingGongBranch,
    ganzhi: null,
    overlay: {},
  };

  // ── 公历时刻 → 农历 ──
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();
  const lunarYear = lunar.getYear();
  const lunarMonthAbs = Math.abs(lunar.getMonth()); // 闰月为负，流月按月序
  const lunarDay = lunar.getDay();
  const hourBranchIdx = chart.birthInfo.hour; // 0=子…11=亥（引擎已归一早/晚子）

  // ── 大限：按当前虚岁（农历年 - 生年 + 1）定位 ──
  const virtualAge = lunarYear - chart.lunarInfo.lunarYear + 1;
  const dx =
    chart.daXians.find((d) => virtualAge >= d.startAge && virtualAge <= d.endAge) ??
    chart.daXians[chart.currentDaXianIndex] ??
    null;
  const daxian: LayerInfo | null = dx
    ? {
        anchorBranch: dx.palaceBranch,
        ganzhi: dx.stemIndex != null ? `${STEMS[dx.stemIndex]}${BRANCHES[dx.palaceBranch]}` : null,
        overlay: dx.stemIndex != null ? buildStarSiHuaMap(dx.stemIndex) : {},
      }
    : null;

  // ── 流年 ──
  // 流年以农历年（正月初一换年），不用公历年
  const nianStemIdx = getYearStemIndex(lunarYear);
  const nianBranchIdx = mod12(lunarYear - 4); // 4=甲子年
  const liunian: LayerInfo = {
    anchorBranch: nianBranchIdx,
    ganzhi: `${STEMS[nianStemIdx]}${BRANCHES[nianBranchIdx]}`,
    overlay: buildStarSiHuaMap(nianStemIdx),
  };

  // ── 流月：斗君法 ──
  // 斗君正月宫 = 流年支宫起正月，顺数至生月，再逆数至生时
  const birthMonth = Math.abs(chart.lunarInfo.lunarMonth);
  const douJun = mod12(nianBranchIdx + (birthMonth - 1) - hourBranchIdx);
  const yueBranchIdx = mod12(douJun + lunarMonthAbs - 1);
  const yueGanIdx = STEMS.indexOf(lunar.getMonthGan());
  const yueGanZhi = `${lunar.getMonthGan()}${lunar.getMonthZhi()}`;
  const liuyue: LayerInfo = {
    anchorBranch: yueBranchIdx,
    ganzhi: yueGanZhi,
    overlay: yueGanIdx >= 0 ? buildStarSiHuaMap(yueGanIdx) : {},
  };

  // ── 流日：流月宫起初一顺数 ──
  const riBranchIdx = mod12(yueBranchIdx + lunarDay - 1);
  const riGanIdx = STEMS.indexOf(lunar.getDayGan());
  const riGanZhi = `${lunar.getDayGan()}${lunar.getDayZhi()}`;
  const liuri: LayerInfo = {
    anchorBranch: riBranchIdx,
    ganzhi: riGanZhi,
    overlay: riGanIdx >= 0 ? buildStarSiHuaMap(riGanIdx) : {},
  };

  // ── 流时：流日宫起子时，顺数至当前时辰（23:00 起子时） ──
  const curHourBranch = Math.floor((date.getHours() + 1) / 2) % 12;
  const shiBranchIdx = mod12(riBranchIdx + curHourBranch);
  const shiStemIdx = hourStemIndex(riGanIdx, curHourBranch);
  const liushi: LayerInfo = {
    anchorBranch: shiBranchIdx,
    ganzhi: `${STEMS[shiStemIdx]}${BRANCHES[shiBranchIdx]}`,
    overlay: buildStarSiHuaMap(shiStemIdx),
  };

  return { benming, daxian, liunian, liuyue, liuri, liushi };
}
