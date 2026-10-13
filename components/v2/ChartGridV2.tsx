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

  // 三方四正虚线（SVG 百分比坐标）
  const sanFangLines = sanFang.map((b) => {
    const [r, c] = branchToArea(b);
    return { x: pct(c), y: pct(r), branch: b };
  });

  const deepOverlay = layerList[activeIdx]?.overlay ?? {};

  return (
    <div className={s.chartCard}>
      <div style={{ position: 'relative', maxWidth: 640, margin: '0 auto' }}>
        {/* 三方四正虚线 */}
        <svg className={s.lines} viewBox="0 0 100 100" preserveAspectRatio="none">
          {sanFangLines.slice(1).map((pt, i) => (
            <path
              key={i}
              d={`M ${pct(branchToArea(sanFang[0])[1])} ${pct(branchToArea(sanFang[0])[0])} L ${pt.x} ${pt.y}`}
              stroke="#7B96C6"
              strokeWidth="1.1"
              strokeDasharray="3 3"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {sanFangLines.map((pt, i) => (
            <circle key={`c${i}`} cx={pt.x} cy={pt.y} r="1.4" fill={i === 0 ? '#4F74B3' : '#7B96C6'} />
          ))}
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
