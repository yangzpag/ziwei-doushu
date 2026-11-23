'use client';

import { useMemo, useState } from 'react';
import { Solar } from 'lunar-javascript';
import { STEMS, BRANCHES } from '@/lib/ziwei/constants';
import { computeLayers, LAYER_META } from '@/lib/ziwei/layers';
import type { ZiweiChart, SiHua } from '@/lib/ziwei/types';
import s from './v2.module.css';

/** 宫位地支索引 → 4x4 网格 [row, col]（寅在左下，逆时针） */
function branchToArea(p: number): [number, number] {
  if (p >= 5 && p <= 8) return [1, p - 4];
  if (p === 9) return [2, 4];
  if (p === 10 || p === 11) return [p - 7, 4];
  if (p === 0) return [4, 3];
  if (p === 1 || p === 2) return [4, 3 - p];
  if (p === 3) return [3, 1];
  return [2, 1]; // 4 辰
}

const PALACE_NAMES = ['命', '兄', '夫', '子', '财', '疾', '迁', '友', '官', '田', '福', '父'];
const LAYER_BADGES = ['命', '限', '年', '月', '日', '时'];
const SIHUA_CLASS: Record<SiHua, string> = { 禄: 'iLu', 权: 'iQs', 科: 'iKe', 忌: 'iJi' };
const SIHUA_OCLASS: Record<SiHua, string> = { 禄: 'iOLu', 权: 'iOQs', 科: 'iOKe', 忌: 'iOJi' };
const SIHUA_CHIP: Record<SiHua, string> = { 禄: '', 权: '', 科: '', 忌: '' };
void SIHUA_CHIP;

function pct(center: number): number {
  return center * 25 - 12.5;
}

/** 走廊（中宫区）= [25,75]²；连线沿走廊边框绕行，不压宫位/中宫文字 */
const CORRIDOR = { lo: 25, hi: 75 };

/** 中心连线与走廊边界的两个交点（Liang-Barsky 裁剪） */
function corridorClip(from: [number, number], to: [number, number]) {
  const [x0, y0] = from;
  const dx = to[0] - x0;
  const dy = to[1] - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p0: number, d: number, lo: number, hi: number) => {
    if (Math.abs(d) < 1e-9) return p0 >= lo && p0 <= hi;
    let ta = (lo - p0) / d;
    let tb = (hi - p0) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    return t0 <= t1;
  };
  if (!clip(x0, dx, CORRIDOR.lo, CORRIDOR.hi)) return null;
  if (!clip(y0, dy, CORRIDOR.lo, CORRIDOR.hi)) return null;
  const A: [number, number] = [x0 + dx * t0, y0 + dy * t0];
  const B: [number, number] = [x0 + dx * t1, y0 + dy * t1];
  return { A, B, dir: [dx, dy] as [number, number] };
}

/** 走廊边框周长参数化（顺时针：上→右→下→左，边长 50） */
function perimeterParam(x: number, y: number): number {
  const lo = CORRIDOR.lo;
  const hi = CORRIDOR.hi;
  const side = hi - lo;
  if (Math.abs(y - lo) < 1e-6) return x - lo;
  if (Math.abs(x - hi) < 1e-6) return side + (y - lo);
  if (Math.abs(y - hi) < 1e-6) return 2 * side + (hi - x);
  return 3 * side + (hi - y);
}

const CORNER_POINTS: [number, number][] = [
  [CORRIDOR.lo, CORRIDOR.lo],
  [CORRIDOR.hi, CORRIDOR.lo],
  [CORRIDOR.hi, CORRIDOR.hi],
  [CORRIDOR.lo, CORRIDOR.hi],
];

/** A→B 沿边框较短一侧行走的折线顶点 */
function corridorRoute(A: [number, number], B: [number, number]): [number, number][] {
  const side = CORRIDOR.hi - CORRIDOR.lo;
  const perim = 4 * side;
  const pa = perimeterParam(A[0], A[1]);
  const pb = perimeterParam(B[0], B[1]);
  const cwSpan = (pb - pa + perim) % perim;
  const cw = cwSpan <= perim / 2;
  const span = cw ? cwSpan : (pa - pb + perim) % perim;
  const pts: [number, number][] = [A];
  for (let k = 0; k <= 3; k++) {
    const rel = cw ? (k * side - pa + perim) % perim : (pa - k * side + perim) % perim;
    if (rel > 1e-6 && rel < span - 1e-6) pts.push(CORNER_POINTS[k]);
  }
  pts.push(B);
  return pts;
}

export default function ChartGridV2({ chart }: { chart: ZiweiChart }) {
  const [activeIdx, setActiveIdx] = useState(1); // 默认 本命+大限
  const [selectedBranch, setSelectedBranch] = useState<number>(chart.mingGongBranch);
  const [date, setDate] = useState<Date>(() => new Date());

  const layers = useMemo(() => computeLayers(chart, date), [chart, date]);
  const layerList = [layers.benming, layers.daxian, layers.liunian, layers.liuyue, layers.liuri, layers.liushi];
  const deep = LAYER_META[activeIdx];

  // 生年四化（从命盘星曜收集）
  const birthSihua = useMemo(() => {
    const out: { star: string; siHua: SiHua }[] = [];
    for (const p of chart.palaces) {
      for (const st of p.stars) {
        if (st.siHua) out.push({ star: st.name, siHua: st.siHua });
      }
    }
    return out;
  }, [chart]);

  // 当前大限
  const curDx = chart.daXians[chart.currentDaXianIndex];

  // 选中宫的三方四正
  const sanFang = useMemo(() => {
    const a = selectedBranch;
    return [a, (a + 4) % 12, (a + 8) % 12, (a + 6) % 12];
  }, [selectedBranch]);

  // 六层宫名叠加 + 底色
  const cellStyle = (p: number): React.CSSProperties | undefined => {
    // 三方四正高亮（选中反馈优先于六层底色）：选中宫深蓝、三合与对宫浅蓝
    if (sanFang.includes(p)) {
      return { background: p === selectedBranch ? '#DCE8F8' : '#EEF4FC' };
    }
    let bg = '';
    for (let i = 0; i <= activeIdx; i++) {
      const L = layerList[i];
      if (L && L.anchorBranch === p) bg = LAYER_META[i].tint;
    }
    if (activeIdx > 0 && !bg) {
      const deepL = layerList[activeIdx];
      if (deepL) {
        const a = deepL.anchorBranch;
        if (p === (a + 4) % 12 || p === (a + 8) % 12 || p === (a + 12 - 6) % 12) bg = LAYER_META[activeIdx].tintTri;
      }
    }
    return bg ? { background: bg } : undefined;
  };

  const lpStack = (p: number) => {
    const out: { prefix: string; name: string; color: string }[] = [];
    for (let i = 1; i <= activeIdx; i++) {
      const L = layerList[i];
      const meta = LAYER_META[i];
      if (!L || !meta.prefix) continue;
      const idx = (L.anchorBranch - p + 12) % 12;
      out.push({ prefix: meta.prefix, name: PALACE_NAMES[idx], color: meta.color });
    }
    return out;
  };

  // 日期导航
  const shiftDate = (dir: 1 | -1) => {
    const d = new Date(date);
    if (activeIdx === 2) d.setFullYear(d.getFullYear() + dir);
    else if (activeIdx === 3) d.setMonth(d.getMonth() + dir);
    else if (activeIdx === 4) d.setDate(d.getDate() + dir);
    else if (activeIdx === 5) d.setHours(d.getHours() + dir);
    setDate(d);
  };
  const shiftDaxian = (dir: 1 | -1) => {
    const idx = chart.daXians.findIndex((d) => d.palaceBranch === layers.daxian?.anchorBranch);
    const next = chart.daXians[(idx + dir + chart.daXians.length) % chart.daXians.length];
    if (next) {
      const years = next.startAge - chart.daXians[chart.currentDaXianIndex].startAge;
      const d = new Date(date);
      d.setFullYear(d.getFullYear() + years);
      setDate(d);
    }
  };

  const lunarLabel = useMemo(() => {
    const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const lunar = solar.getLunar();
    const leap = lunar.getMonth() < 0 ? '闰' : '';
    return `${lunar.getYearGan()}${lunar.getYearZhi()}年 ${leap}${Math.abs(lunar.getMonth())}月${lunar.getDay()}日`;
  }, [date]);

  const navDateLabel = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  // 三方四正连线：对宫（暖红）/三合（深蓝）分色，沿中宫边框绕行 + 端点箭头
  const sanFangLinks = useMemo(() => {
    const kinds: { branch: number; color: string; kind: string }[] = [
      { branch: (selectedBranch + 6) % 12, color: '#B3574C', kind: '对宫' },
      { branch: (selectedBranch + 4) % 12, color: '#3D66A8', kind: '三合' },
      { branch: (selectedBranch + 8) % 12, color: '#3D66A8', kind: '三合' },
    ];
    const [sr, sc] = branchToArea(sanFang[0]);
    return kinds
      .map((k) => {
        const clip = corridorClip([pct(sc), pct(sr)], (() => {
          const [r, c] = branchToArea(k.branch);
          return [pct(c), pct(r)] as [number, number];
        })());
        if (!clip) return null;
        const pts = corridorRoute(clip.A, clip.B);
        const L = Math.hypot(clip.dir[0], clip.dir[1]) || 1;
        return { ...k, pts, dir: [clip.dir[0] / L, clip.dir[1] / L] as [number, number] };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [sanFang, selectedBranch]);

  const deepOverlay = layerList[activeIdx]?.overlay ?? {};

  return (
    <div className={s.chartCard}>
      <div style={{ position: 'relative', maxWidth: 640, margin: '0 auto' }}>
        {/* 三方四正连线：沿中宫边框走线（不压文字），端点箭头指向目标宫 */}
        <svg className={s.lines} viewBox="0 0 100 100" preserveAspectRatio="none">
          {sanFangLinks.map((lk, i) => {
            const d = lk.pts.map((p, j) => `${j ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ');
            const [bx, by] = lk.pts[lk.pts.length - 1];
            const [ux, uy] = lk.dir;
            const back: [number, number] = [bx - ux * 3, by - uy * 3];
            const px = -uy;
            const py = ux;
            return (
              <g key={i} opacity="0.92">
                <path
                  d={d}
                  stroke={lk.color}
                  strokeWidth="1.5"
                  strokeDasharray="5 3"
                  fill="none"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={lk.pts[0][0]} cy={lk.pts[0][1]} r="1.2" fill={lk.color} />
                <polygon
                  points={`${bx},${by} ${back[0] + px * 1.6},${back[1] + py * 1.6} ${back[0] - px * 1.6},${back[1] - py * 1.6}`}
                  fill={lk.color}
                />
              </g>
            );
          })}
        </svg>

        <div className={s.chart}>
          {Array.from({ length: 12 }, (_, p) => {
            const palace = chart.palaces.find((pl) => pl.branch === p);
            if (!palace) return null;
            const [row, col] = branchToArea(p);
            const majors = palace.stars.filter((st) => st.type === 'major');
            const minors = palace.stars.filter((st) => st.type !== 'major').map((st) => st.name);
            const stack = lpStack(p);
            return (
              <div
                key={p}
                className={s.cell}
                style={{ gridArea: `${row}/${col}`, ...cellStyle(p) }}
                onClick={() => setSelectedBranch(p)}
              >
                <div className={s.cTop}>
                  <span className={s.gz}>
                    {STEMS[palace.stem]}
                    {BRANCHES[palace.branch]}
                  </span>
                  <span className={s.pn}>
                    {palace.name}
                    {palace.isShenGong && <span className={s.shen}>身</span>}
                  </span>
                </div>
                <div className={s.stars}>
                  {majors.length === 0 && palace.isEmpty && <div className={s.kj}>空宫 · 借对宫</div>}
                  {majors.map((st) => {
                    const deepSiHua = deepOverlay[st.name];
                    const birthSiHua = st.siHua;
                    return (
                      <div key={st.name} className={s.ms}>
                        {st.name}
                        {birthSiHua && <i className={SIHUA_CLASS[birthSiHua]}>{birthSiHua}</i>}
                        {deepSiHua && activeIdx >= 2 && (
                          <i className={SIHUA_OCLASS[deepSiHua as SiHua]}>
                            {LAYER_META[activeIdx].label.slice(1) || '流'}
                            {deepSiHua}
                          </i>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className={s.lpStack}>
                  {stack.map((it, i) => (
                    <span key={i} className={s.lp} style={{ color: it.color }}>
                      {it.prefix}
                      {it.name}
                    </span>
                  ))}
                </div>
                <div className={s.cBot}>
                  <span className={s.mi}>{minors.slice(0, 3).join(' ')}</span>
                </div>
              </div>
            );
          })}

          {/* 中宫 */}
          <div className={s.center}>
            <div className={s.centerT}>
              {chart.yinYangGender || ''} · {chart.wuxingJuName}
            </div>
            <div className={s.centerS1}>
              {BRANCHES[chart.lunarInfo.yearBranch]}年 · 命主 {chart.mingZhu ?? '—'} · 身主 {chart.shenZhu ?? '—'}
            </div>
            {chart.lunarInfo.fourPillarsLunar && (
              <div className={s.sizi}>
                {['年柱', '月柱', '日柱', '时柱'].map((label, i) => {
                  const gz = chart.lunarInfo.fourPillarsLunar![i];
                  return (
                    <div key={label}>
                      <i>{label}</i>
                      <b>{gz[0]}</b>
                      <b>{gz[1]}</b>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={s.sc4}>
              生年四化
              {birthSihua.map((it) => (
                <i key={it.star + it.siHua} className={`${s.chip} ${s[SIHUA_CLASS[it.siHua]]}`}>
                  {it.star}·{it.siHua}
                </i>
              ))}
            </div>
            {curDx && (
              <div className={s.daCard}>
                <b>
                  当前大限 {curDx.startAge}–{curDx.endAge} 岁
                </b>
                大限命宫行至{BRANCHES[curDx.palaceBranch]} · {curDx.palaceName}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 连线图例 */}
      <div
        style={{
          display: 'flex', justifyContent: 'center', gap: 20, maxWidth: 640,
          margin: '8px auto 0', fontSize: 11.5, color: '#8a7a5c', userSelect: 'none',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ display: 'inline-block', width: 20, borderTop: '2px dashed #3D66A8' }} />
          三合
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ display: 'inline-block', width: 20, borderTop: '2px dashed #B3574C' }} />
          对宫
        </span>
        <span style={{ opacity: 0.75 }}>点击宫位查看其三方四正</span>
      </div>

      {/* 六层 tabs */}
      <div className={s.layTabs} role="tablist">
        {LAYER_META.map((meta, i) => (
          <span
            key={meta.key}
            role="tab"
            tabIndex={0}
            aria-selected={activeIdx === i}
            className={activeIdx === i ? s.layOn : ''}
            style={{ ['--lc' as string]: meta.color, cursor: 'pointer' }}
            onClick={() => setActiveIdx(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveIdx(i);
              }
            }}
          >
            <i style={{ background: meta.color }} />
            {meta.label}
          </span>
        ))}
      </div>

      {/* 日期导航 */}
      {activeIdx > 0 && (
        <div className={s.navRow}>
          <button
            type="button"
            className={s.navArrow}
            onClick={() => (activeIdx === 1 ? shiftDaxian(-1) : shiftDate(-1))}
          >
            ‹
          </button>
          <div className={s.navPill}>
            <span>
              {activeIdx === 1 && layers.daxian
                ? `${layers.daxian.ganzhi ?? ''} 大限`
                : activeIdx === 2
                  ? `${date.getFullYear()} 年`
                  : activeIdx === 3
                    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
                    : navDateLabel}
            </span>
            <small>{lunarLabel}</small>
            <span className={s.navBadge} style={{ background: deep.color }}>
              {LAYER_BADGES[activeIdx]}
            </span>
          </div>
          <button
            type="button"
            className={s.navArrow}
            onClick={() => (activeIdx === 1 ? shiftDaxian(1) : shiftDate(1))}
          >
            ›
          </button>
        </div>
      )}

      <div className={s.chartCap}>
        <span>
          已选：{chart.palaces.find((pl) => pl.branch === selectedBranch)?.name ?? ''} · 三方四正
        </span>
        <span>点任意宫格切换三方四正</span>
      </div>
    </div>
  );
}
