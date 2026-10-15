/**
 * 路由器：判断问题该查课程库（RAG）还是直接回答。
 *
 * 双信号设计（校准数据：相关 0.58-0.72 / 无关跨域 0.31-0.56，中间有重叠带）：
 *   1. 相似度分数（top-1）——主信号：
 *      ≥ RAG_HIGH   → 直接走 RAG（确定相关）
 *      ≤ DIRECT_LOW → 直接回答（确定无关）
 *      中间地带     → LLM 分类（语义判断，deepseek-flash 一次短调用）
 *   2. 关键词直通：问题明确点名课程（倪师/本草经/条文…）→ 无论分数直接 RAG
 *
 * 阈值来自 scripts/kb/calibrate-router.ts 的实测分布，可用环境变量覆盖。
 */
import Anthropic from '@anthropic-ai/sdk';
import { embedQuery, searchSegmentsByVec } from './search';

const RAG_HIGH = Number(process.env.KB_RAG_HIGH ?? '0.62');
const DIRECT_LOW = Number(process.env.KB_DIRECT_LOW ?? '0.40');
/** 走了 RAG 但分数低于此值 = 库内没有真正相关内容 */
const NO_HIT = Number(process.env.KB_NO_HIT ?? '0.45');

const COURSE_KEYWORDS = [
  '倪师', '倪海厦', '人纪', '本草经', '伤寒论', '金匮', '黄帝内经', '针灸', '仲景心法',
  '条文', '课程里', '视频里', '第几集',
];

export type RouteDecision = 'rag' | 'direct';

export interface RouteResult {
  decision: RouteDecision;
  score: number;
  reason: string;
  /** 中间地带是否动用了 LLM 分类 */
  usedLlm: boolean;
}

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    timeout: 6_000,
    maxRetries: 0, // 分类失败快速回退分数判断
  });
}

/** 中间地带：让模型做二分类（一次短调用；网络不通时 6s 快速失败回退分数判断） */
async function llmClassify(q: string, topTitle: string, score: number): Promise<RouteDecision | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.messages.create(
      {
        model: process.env.AI_MODEL || 'deepseek-chat',
        max_tokens: 20,
        messages: [
          {
            role: 'user',
            content: `判断用户问题是否需要查询「倪海厦人纪中医课程库」（伤寒论/金匮/本草经/内经/针灸讲课摘录）。
只回答一个词：RAG（需要查库）或 DIRECT（不需要，通用问题/闲聊/与课程无关）。
问题：${q}
参考：库内最相近段落是「${topTitle}」（相似度 ${score.toFixed(2)}）。`,
          },
        ],
      },
      { timeout: 6_000 }
    );
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .toUpperCase();
    if (text.includes('RAG')) return 'rag';
    if (text.includes('DIRECT')) return 'direct';
    return null;
  } catch {
    return null; // 分类失败 → 回退分数判断
  }
}

export async function routeQuery(q: string): Promise<RouteResult> {
  // 关键词直通：明确点名课程内容
  if (COURSE_KEYWORDS.some((k) => q.includes(k))) {
    return { decision: 'rag', score: 1, reason: '问题明确指向课程内容', usedLlm: false };
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  const vec = await embedQuery(q);
  // 复用混合检索（向量 + 标题命中）取 top-1 分数作为路由主信号
  const top = databaseUrl
    ? (await searchSegmentsByVec(q, vec, { databaseUrl, limit: 1 }))[0]
    : undefined;
  const score = top?.score ?? 0;

  if (score >= RAG_HIGH) {
    return { decision: 'rag', score, reason: `相似度 ${score.toFixed(2)} ≥ ${RAG_HIGH}（确定相关）`, usedLlm: false };
  }
  if (score <= DIRECT_LOW) {
    return { decision: 'direct', score, reason: `相似度 ${score.toFixed(2)} ≤ ${DIRECT_LOW}（确定无关）`, usedLlm: false };
  }

  // 中间地带：LLM 语义分类；失败回退为按阈值偏 RAG（宁可查库给引用，也不错过度）
  const llm = await llmClassify(q, top?.title ?? '', score);
  if (llm) {
    return { decision: llm, score, reason: `中间地带（${score.toFixed(2)}），LLM 判定 ${llm === 'rag' ? '需查库' : '可直接回答'}`, usedLlm: true };
  }
  return { decision: 'rag', score, reason: `中间地带（${score.toFixed(2)}），LLM 不可用，偏保守走查库`, usedLlm: true };
}

/** 走了 RAG 但库内没有真正命中的内容 */
export function isNoHit(score: number): boolean {
  return score < NO_HIT;
}

export { embedQuery, searchSegmentsByVec };
