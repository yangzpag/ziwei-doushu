/**
 * 内容哈希缓存：缓存键包含内容哈希 + 配置版本，
 * 上游内容变化 → 上游哈希变化 → 下游缓存键变化 → 自动失效。
 */
import crypto from 'node:crypto';

/** 稳定 JSON（键排序，保证同内容同哈希） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return crypto.createHash('sha1').update(stableStringify(value)).digest('hex');
}

export interface StageInputRef {
  id: string;
  hash: string;
}

/** 阶段缓存键：stage + 配置版本 + 全部上游输入的内容哈希 */
export function stageKey(stage: string, configVersion: string, inputs: StageInputRef[]): string {
  const merged = inputs
    .map((i) => `${i.id}:${i.hash}`)
    .sort()
    .join('|');
  return `${stage}-${configVersion}-${crypto.createHash('sha1').update(merged).digest('hex').slice(0, 16)}`;
}
