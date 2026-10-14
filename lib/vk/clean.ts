/**
 * 字幕清洗：原始文本不可覆盖，另存 clean_text。
 *
 * 规则（保守，只做确定性操作）：
 * 1. 丢弃无意义噪声（纯语气词 / 纯括号注解 / 纯符号）；
 * 2. 短窗口内的重复识别去重；
 * 3. 合并明显断行（仅 full_transcript 模式；摘录永不合并）；
 * 4. 术语词表命中：存疑词只打 reviewFlag，不自动改写；
 * 5. 保留否定、条件、转折、数值、剂量与单位——清洗阶段不删除任何内容字符。
 *
 * 每一步都记录 cleanOps，被合并/丢弃的行保留独立记录（mergedInto/dropped），
 * 保证所有修改可回溯到原始字幕 ID。
 */
import type { CleanedEvidence, Evidence, TranscriptMode } from './types';
import { Glossary } from './glossary';

export interface CleanOptions {
  mode: TranscriptMode;
  noisePatterns: string[];
  /** 低于该字数视为断行碎片（full_transcript 才合并） */
  minCueChars: number;
  /** 碎片与前后证据的起始间隔小于此值才合并 */
  mergeGapMs: number;
  /** 相同文本在此窗口内视为重复识别 */
  dedupeWindowMs: number;
  glossary?: Glossary;
}

const SENTENCE_ENDERS = /[。！？!?…»」』）)]$/;

export function cleanEvidence(evidence: Evidence[], opts: CleanOptions): CleanedEvidence[] {
  const cleaned: CleanedEvidence[] = evidence.map((e) => ({
    ...e,
    cleanText: '',
    cleanOps: [],
    reviewFlags: [],
    dropped: null,
  }));

  // 1) 基础清洗：噪声判定 + 词表标记
  for (const c of cleaned) {
    const text = c.rawText.replace(/\s+/g, ' ').trim();
    c.cleanOps.push('normalize-space');
    if (!text || isNoise(text, opts.noisePatterns)) {
      c.dropped = 'noise';
      c.cleanOps.push(`drop:noise`);
      c.cleanText = '';
      continue;
    }
    c.cleanText = text;
    if (opts.glossary) {
      for (const m of opts.glossary.match(text)) {
        if (m.certainty === 'uncertain') {
          c.reviewFlags.push(`uncertain-term:${m.term}`);
        }
      }
    }
  }

  // 2) 短窗口重复识别去重（相同文本 + 时间接近）
  const keptSoFar: CleanedEvidence[] = [];
  for (const c of cleaned) {
    if (c.dropped) continue;
    const dup = keptSoFar.find(
      (k) =>
        k.cleanText === c.cleanText &&
        Math.abs(k.tStartMs - c.tStartMs) <= opts.dedupeWindowMs
    );
    if (dup) {
      c.dropped = 'duplicate';
      c.cleanOps.push(`drop:duplicate-of:${dup.id}`);
      c.cleanText = '';
      continue;
    }
    keptSoFar.push(c);
  }

  // 3) 合并明显断行（仅完整逐字稿；摘录的短引文是独立证据，永不合并）
  if (opts.mode === 'full_transcript') {
    const live = cleaned.filter((c) => !c.dropped);
    for (let i = 0; i < live.length; i++) {
      const cur = live[i];
      if (cur.cleanText.length >= opts.minCueChars) continue;
      if (SENTENCE_ENDERS.test(cur.cleanText)) continue;
      // 找下一条存活证据，间隔足够小才合并
      const next = live[i + 1];
      if (!next) continue;
      const gap = next.tStartMs - (cur.tEndMs ?? cur.tStartMs);
      if (gap > opts.mergeGapMs) continue;
      cur.cleanText = `${cur.cleanText}${next.cleanText}`;
      cur.cleanOps.push(`merge:${next.id}`);
      cur.tEndMs = next.tEndMs ?? cur.tEndMs;
      next.mergedInto = cur.id;
      next.cleanOps.push(`merged-into:${cur.id}`);
    }
  }

  return cleaned;
}

function isNoise(text: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (new RegExp(p).test(text)) return true;
    } catch {
      // 非法正则忽略
    }
  }
  // 去掉标点后没有实质内容
  const stripped = text.replace(/[\p{P}\p{S}\s]/gu, '');
  return stripped.length === 0;
}
