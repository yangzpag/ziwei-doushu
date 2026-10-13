/**
 * 中医知识库 · 部元数据（与 nihai-renji-corpus README / 设计稿一致）
 * 纯客户端可用（无服务端依赖）。
 */
export interface BookMeta {
  id: string;
  name: string;
  short: string;
  no: string;
  desc: string;
  chips: string[];
}

export const BOOKS: BookMeta[] = [
  {
    id: '01-shanghan', name: '伤寒论', short: '伤', no: '壹',
    desc: '六经辨证总纲，以宋本 398 条为锚，逐条拆解方证对应与临证加减，是倪师经方体系的骨架。',
    chips: ['太阳中风是什么道理', '桂枝汤怎么用', '小柴胡汤证', '少阳病提纲'],
  },
  {
    id: '02-jinkui', name: '金匮要略', short: '金', no: '贰',
    desc: '脏腑经络至妇人杂病二十二篇，杂病诊治大全，含大量临床病例与方剂化裁。',
    chips: ['痰饮怎么治', '胸痹的病机', '妇人杂病', '百合病'],
  },
  {
    id: '03-bencao', name: '神农本草经', short: '本', no: '叁',
    desc: '序例与玉石、草部上中下品，按药名立目，讲每味药的性味、主治与倪师用药心得。',
    chips: ['黄连的药性', '附子怎么用', '石膏与知母', '人参的取舍'],
  },
  {
    id: '04-neijing', name: '黄帝内经', short: '内', no: '肆',
    desc: '素问一至八十一篇（含遗篇），按篇立目，讲阴阳、藏象、经络与养生医理的源头。',
    chips: ['上古天真论讲了什么', '阴阳应象', '四气调神', '五脏与情志'],
  },
  {
    id: '05-zhongjing', name: '仲景心法', short: '仲', no: '伍',
    desc: '倪师对伤寒金匮的复讲与临证心法串讲，把经方背后的思路讲透。',
    chips: ['为什么要顾胃气', '扶阳的思路', '经方组方思路'],
  },
  {
    id: '06-zhenjiu', name: '针灸大成', short: '针', no: '陆',
    desc: '十二正经、奇经八脉、十五络，针法补泻、治症、子午流注与临床实操，44 集最完整的针灸课。',
    chips: ['足三里主治', '补泻手法', '子午流注', '腰痛怎么下针'],
  },
];

const BY_ID = new Map(BOOKS.map((b) => [b.id, b]));

export function bookMeta(id: string): BookMeta | undefined {
  return BY_ID.get(id);
}

export function bookName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

export function bookShort(id: string): string {
  return BY_ID.get(id)?.short ?? '';
}

/** B 站秒级回放链接 */
export function biliUrl(bvid: string, tHms: string): string {
  const parts = tHms.split(':').map(Number);
  const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : 0;
  return `https://www.bilibili.com/video/${bvid}?t=${sec}`;
}
