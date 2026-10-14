/**
 * 内容类型注册表：解析 extends 链、章节级类型识别、配置版本号（缓存键用）。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { ContentTypeConfig } from './configs';
export type { ContentTypeConfig } from './configs';
import { BUILTIN_CONFIGS } from './configs';
import { Glossary } from '../glossary';

const registry = new Map<string, ContentTypeConfig>();
for (const c of BUILTIN_CONFIGS) registry.set(c.id, c);

const resolvedCache = new Map<string, ContentTypeConfig>();
const glossaryCache = new Map<string, Glossary>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深度合并：数组整体替换，对象递归 */
function mergeDeep(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? mergeDeep(base[k], v) : v;
  }
  return out;
}

/** 取配置（解析 extends 链）。未知 id → 抛错（调用方用 resolveConfig 兜底） */
export function getConfig(id: string): ContentTypeConfig {
  const cached = resolvedCache.get(id);
  if (cached) return cached;
  const raw = registry.get(id);
  if (!raw) throw new Error(`未知内容类型: ${id}（可用: ${[...registry.keys()].join(', ')}）`);
  let config: ContentTypeConfig = raw;
  const chain: string[] = [];
  let cur: ContentTypeConfig | undefined = raw;
  while (cur?.extends) {
    if (chain.includes(cur.id)) throw new Error(`配置 extends 成环: ${cur.id}`);
    chain.push(cur.id);
    const parent = registry.get(cur.extends);
    if (!parent) throw new Error(`配置 ${cur.id} 的父配置不存在: ${cur.extends}`);
    config = mergeDeep(parent, config) as ContentTypeConfig;
    cur = parent;
  }
  resolvedCache.set(id, config);
  return config;
}

/** 兜底解析：无法确定类型时回退通用讲解，不强行分类 */
export function resolveConfig(id?: string | null): ContentTypeConfig {
  if (!id) return getConfig('generic-lecture');
  try {
    return getConfig(id);
  } catch {
    return getConfig('generic-lecture');
  }
}

export function listConfigs(): ContentTypeConfig[] {
  return [...registry.values()];
}

/** 配置加载的词表（懒加载 + 缓存）；未配置返回 null */
export function glossaryFor(config: ContentTypeConfig): Glossary | null {
  if (!config.glossaryFile) return null;
  const cached = glossaryCache.get(config.glossaryFile);
  if (cached) return cached;
  const g = Glossary.fromFile(path.resolve(process.cwd(), config.glossaryFile));
  glossaryCache.set(config.glossaryFile, g);
  return g;
}

/**
 * 章节级内容类型识别：用章节标题/文本对每个候选配置打分
 * （词表命中 + textPatterns 命中）。最高分且严格领先才采用，
 * 否则返回 null（跟随视频级配置）——不强行分类。
 */
export function detectChapterType(
  title: string,
  sampleText: string,
  candidates: string[] = [...registry.keys()]
): string | null {
  const scores: { id: string; score: number }[] = [];
  for (const id of candidates) {
    const config = getConfig(id);
    let score = 0;
    for (const p of config.chapter.textPatterns) {
      try {
        if (new RegExp(p).test(title)) score += 2;
        if (new RegExp(p).test(sampleText)) score += 1;
      } catch {
        // 忽略非法正则
      }
    }
    const glossary = glossaryFor(config);
    if (glossary) {
      const hits = glossary.match(`${title} ${sampleText.slice(0, 500)}`);
      score += Math.min(hits.length, 5);
    }
    if (score > 0) scores.push({ id, score });
  }
  if (!scores.length) return null;
  scores.sort((a, b) => b.score - a.score);
  if (scores.length > 1 && scores[0].score === scores[1].score) return null; // 打平不猜
  return scores[0].id;
}

/** 配置的父链（不含自身） */
export function ancestorsOf(id: string): string[] {
  const out: string[] = [];
  let cur = registry.get(id);
  while (cur?.extends) {
    if (out.includes(cur.extends)) break; // 防环
    out.push(cur.extends);
    cur = registry.get(cur.extends);
  }
  return out;
}

/** 配置版本号：内置配置全量哈希（缓存键组成部分，配置变则缓存失效） */
export const CONFIG_VERSION: string = crypto
  .createHash('sha1')
  .update(JSON.stringify(BUILTIN_CONFIGS))
  .digest('hex')
  .slice(0, 12);
