/* eslint-disable react/no-array-index-key */
import s from './v2.module.css';

/** 首页右侧静态示例命盘（设计稿示意数据：甲干四化 廉禄/破权/武科/阳忌） */
export default function SampleChart() {
  const cells: {
    area: string; gz: string; pn: string; shen?: boolean;
    stars: { name: string; tag?: '禄' | '权' | '科' | '忌' }[];
    mi?: string; kj?: string; dj?: string; main?: boolean;
  }[] = [
    { area: '1/1', gz: '己巳', pn: '父母', stars: [{ name: '太阴' }], dj: '114–123' },
    { area: '1/2', gz: '庚午', pn: '福德', stars: [{ name: '贪狼' }], mi: '火星', dj: '104–113' },
    { area: '1/3', gz: '辛未', pn: '田宅', stars: [{ name: '天同' }, { name: '巨门' }], dj: '94–103' },
    { area: '1/4', gz: '壬申', pn: '官禄', shen: true, stars: [{ name: '武曲', tag: '科' }, { name: '天相' }], mi: '右弼', dj: '84–93' },
    { area: '2/1', gz: '戊辰', pn: '命宫', main: true, stars: [{ name: '廉贞', tag: '禄' }, { name: '天府' }], mi: '左辅 天魁', dj: '4–13' },
    { area: '2/4', gz: '癸酉', pn: '交友', stars: [{ name: '太阳', tag: '忌' }, { name: '天梁' }], mi: '天钺', dj: '74–83' },
    { area: '3/1', gz: '丁卯', pn: '兄弟', stars: [], kj: '空宫 · 借对宫', dj: '14–23' },
    { area: '3/4', gz: '甲戌', pn: '迁移', stars: [{ name: '七杀' }], mi: '陀罗', dj: '64–73' },
    { area: '4/1', gz: '丙寅', pn: '夫妻', stars: [{ name: '破军', tag: '权' }], mi: '擎羊', dj: '24–33' },
    { area: '4/2', gz: '丁丑', pn: '子女', stars: [], kj: '空宫 · 借对宫', dj: '34–43' },
    { area: '4/3', gz: '丙子', pn: '财帛', stars: [{ name: '紫微' }], mi: '禄存', dj: '44–53' },
    { area: '4/4', gz: '乙亥', pn: '疾厄', stars: [{ name: '天机' }], dj: '54–63' },
  ];
  const tagCls: Record<string, string> = { 禄: s.iLu, 权: s.iQs, 科: s.iKe, 忌: s.iJi };

  return (
    <div className={s.chart} style={{ maxWidth: 410 }}>
      {cells.map((c, i) => (
        <div key={i} className={s.cell} style={{ gridArea: c.area, ...(c.main ? { background: '#FBF3DE', boxShadow: 'inset 0 0 0 1.5px var(--zw2-gold)' } : {}) }}>
          <div className={s.cTop}>
            <span className={s.gz}>{c.gz}</span>
            <span className={s.pn}>
              {c.pn}
              {c.shen && <span className={s.shen}>身</span>}
            </span>
          </div>
          <div className={s.stars}>
            {c.stars.map((st) => (
              <div key={st.name} className={s.ms}>
                {st.name}
                {st.tag && <i className={tagCls[st.tag]}>{st.tag}</i>}
              </div>
            ))}
          </div>
          <div className={s.cBot}>
            <span className={c.kj ? s.kj : s.mi}>{c.kj ?? c.mi ?? ''}</span>
            <span className={s.mi} style={{ fontSize: 9 }}>{c.dj}</span>
          </div>
        </div>
      ))}
      <div className={s.center}>
        <div className={s.centerT} style={{ fontSize: 21, letterSpacing: 7 }}>紫微斗数</div>
        <div style={{ width: 40, height: 1, background: 'var(--zw2-line2)' }} />
        <div className={s.centerS1}>乾造 · 甲子年 · 金四局</div>
        <div className={s.centerS1} style={{ fontSize: 10.5, color: 'var(--zw2-muted)' }}>命主 廉贞 · 身主 火星</div>
        <div className={s.ccLg}>
          <span><i style={{ background: '#3F7D4E' }} />禄</span>
          <span><i style={{ background: '#7B5AA6' }} />权</span>
          <span><i style={{ background: '#3A6EA5' }} />科</span>
          <span><i style={{ background: '#B5484D' }} />忌</span>
        </div>
      </div>
    </div>
  );
}
