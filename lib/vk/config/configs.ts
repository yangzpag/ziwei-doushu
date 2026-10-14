/**
 * 内容类型配置 —— 通用视频知识流水线的「可配置内容类型」层。
 *
 * 通用模块（导入/时间轴/清洗/切分/摘要/校验/索引）不感知任何领域；
 * 领域差异全部收敛到本配置：章节线索、切分参数、摘要侧重、
 * 可选结构化字段与专项校验。第一版内置：
 *   - generic-lecture   通用讲解（兜底类型）
 *   - book-commentary   原书讲解
 *   - shennong-bencao   神农本草经（book-commentary 的领域配置，测试样本）
 */

export interface StructuredFieldSpec {
  name: string;
  kind: 'list' | 'text';
  /** 从文本正则抽取 */
  patterns?: string[];
  /** 从术语词表抽取（配置了 glossaryFile 时可用） */
  fromGlossary?: boolean;
}

export interface ContentTypeConfig {
  id: string;
  name: string;
  extends?: string;
  description: string;
  chapter: {
    /** 摘录模式的章节来源字段（按序取第一个命中的） */
    sourceFields: string[];
    /** 字幕文本中的粗粒度章节线索（正则） */
    textPatterns: string[];
    /** 无任何线索时的兜底标题 */
    fallbackTitle: string;
  };
  clean: {
    noisePatterns: string[];
    minCueChars: number;
    mergeGapMs: number;
    dedupeWindowMs: number;
  };
  segment: {
    /** 初始时长参考区间——仅候选边界线索，不机械按时长切分 */
    refDurationMs: [number, number];
    /** 起始间隔超过该值 → 候选边界 */
    gapMs: number;
    /** 超过该间隔不允许拼接（摘录缺口保护） */
    maxMergeGapMs: number;
    /** 摘录模式的间隔阈值（摘录采样间隔本身就有几十秒，与字幕 cue 不同） */
    excerpt: {
      /** 章节内摘录间隔超过该值 → 候选边界 */
      gapMs: number;
      /** 超过该间隔不允许拼接 */
      maxMergeGapMs: number;
    };
    /** 口头主题切换线索 */
    transitionPatterns: string[];
    /** 语义完整性标志（句末） */
    sentenceEnders: string[];
    minEvidence: number;
    minChars: number;
    /** 段尾不完整时向后寻找完整句子的最大跨度 */
    maxExtendMs: number;
  };
  summary: {
    focus: string;
    targetChars: [number, number];
    /** 优先抽取的句子特征（数值/剂量/否定/条件等） */
    priorityPatterns: string[];
    /** 整理文本中删除的口头冗余（保守集合） */
    fillerPatterns: string[];
  };
  structuredFields: StructuredFieldSpec[];
  validation: {
    requireContinuity: boolean;
    /** 必须保留的标志（否定/条件/转折）——摘要丢失即告警 */
    mustKeepPatterns: string[];
    excerptMustBePartial: boolean;
  };
  /** 术语词表路径（相对仓库根） */
  glossaryFile?: string;
}

const MUST_KEEP_BASE = [
  '不是', '没有', '不能', '不会', '不应', '不可以', '禁止', '切忌',
  '如果', '除非', '但是', '然而', '首先', '例外', '反而',
];

export const GENERIC_LECTURE: ContentTypeConfig = {
  id: 'generic-lecture',
  name: '通用讲解',
  description: '通用授课/讲座视频：无固定结构，按主题切分知识段落。无法确定类型时的兜底配置。',
  chapter: {
    sourceFields: [],
    // 只放强结构线索（第X章/第X条/卷X/篇X）：弱线索（「今天我们讲…」）
    // 属于段内过渡语，放进 segment.transitionPatterns，否则会把开场白切成一章
    textPatterns: ['第[一二三四五六七八九十百\\d]+[章节讲部篇]'],
    fallbackTitle: '全片主题',
  },
  clean: {
    noisePatterns: [
      '^[（(【\\[][^)）\\]】]{0,24}[)）\\]】]$', // 纯括号注解（音乐/鼓掌）
      '^[字幕组|字幕|www\\.|https?://]',
      '^(嗯|啊|呃|哦|哎|噢)+$',
      '^[！？。，、；：“”‘’（）\\s]+$',
    ],
    minCueChars: 6,
    mergeGapMs: 2_000,
    dedupeWindowMs: 3_000,
  },
  segment: {
    refDurationMs: [60_000, 180_000],
    gapMs: 6_000,
    maxMergeGapMs: 15_000,
    excerpt: { gapMs: 45_000, maxMergeGapMs: 120_000 },
    // 口头切换语（正则，只匹配字幕开头一小段）
    transitionPatterns: [
      '我们?来?看',
      '接下来',
      '下一[个章本节集讲部分]',
      '首先我',
      '最后(我们)?(来)?(总结|看|说)',
      '总结一下',
      '换一?个',
      '另外',
      '再?来看',
      '回过头',
    ],
    sentenceEnders: ['。', '！', '？', '…'],
    minEvidence: 2,
    minChars: 60,
    maxExtendMs: 120_000,
  },
  summary: {
    focus: '讲解的核心观点、结论与适用条件',
    targetChars: [150, 300],
    priorityPatterns: [
      '\\d+\\s*(毫克|克|g|ml|两|钱|片|丸|汤|付|%|％|度|分钟|小时|次|天|周|年)',
      '因为|所以|如果|除非|但是|然而|由于',
      '不[是能有过该]|没有|未|禁|切',
    ],
    fillerPatterns: ['呢', '啊', '吧', '哦', '嗯', '呃', '那个那个', '对不对', '是吧', '怎么说呢'],
  },
  structuredFields: [],
  validation: {
    requireContinuity: true,
    mustKeepPatterns: MUST_KEEP_BASE,
    excerptMustBePartial: true,
  },
};

export const BOOK_COMMENTARY: ContentTypeConfig = {
  ...GENERIC_LECTURE,
  id: 'book-commentary',
  extends: 'generic-lecture',
  name: '原书讲解',
  description: '逐条/逐篇讲解古籍原著的课程：以原文条目为粗粒度章节，整理讲者的解释与案例。',
  chapter: {
    sourceFields: [],
    textPatterns: [
      '第[一二三四五六七八九十百\\d]+条',
      '卷[一二三四五六七八九十]',
      '篇[一二三四五六七八九十]',
    ],
    fallbackTitle: '原文讲解',
  },
  segment: {
    ...GENERIC_LECTURE.segment,
    refDurationMs: [60_000, 150_000],
  },
  summary: {
    ...GENERIC_LECTURE.summary,
    focus: '讲者对原文的解释、案例与用法；与原文表述明确区分',
  },
  structuredFields: [
    { name: 'passage_ref', kind: 'text', patterns: ['第[一二三四五六七八九十百\\d]+条', '卷[一二三四五六七八九十]', '篇[一二三四五六七八九十]'] },
  ],
};

export const SHENNONG_BENCAO: ContentTypeConfig = {
  ...BOOK_COMMENTARY,
  id: 'shennong-bencao',
  extends: 'book-commentary',
  name: '神农本草经讲解',
  description: '倪海厦《人纪·神农本草经》讲课：按药材立目，整理每味药的本经讲解与用法。领域配置，不写死药材结构。',
  glossaryFile: 'data/vk/glossaries/shennong-bencao-herbs.txt',
  chapter: {
    ...BOOK_COMMENTARY.chapter,
    sourceFields: ['h2', 'h3'],
    textPatterns: [...BOOK_COMMENTARY.chapter.textPatterns, '第[一二三四五六七八九十百\\d]+味'],
  },
  summary: {
    ...BOOK_COMMENTARY.summary,
    focus: '单味药材的本经原文讲解、性味功效与课堂用法案例',
  },
  structuredFields: [
    ...BOOK_COMMENTARY.structuredFields,
    { name: 'herbs', kind: 'list', fromGlossary: true },
  ],
};

export const BUILTIN_CONFIGS: ContentTypeConfig[] = [
  GENERIC_LECTURE,
  BOOK_COMMENTARY,
  SHENNONG_BENCAO,
];
