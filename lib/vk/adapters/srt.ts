/**
 * SRT 适配器：SRT 文本 → 统一 Evidence 列表。
 *
 * 容错：去 HTML 标签、去 {\an8} 位置码、容忍缺失序号行与多行文本。
 */
import type { Evidence, EvidenceKind } from '../types';
import { parseTimestampToMs } from '../timeline';

export interface SubtitleParseOptions {
  videoId: string;
  /** 字幕默认来源（可覆写为 ocr 等预留类型） */
  source?: EvidenceKind;
}

export interface SubtitleParseResult {
  evidence: Evidence[];
  /** 解析诊断（跳过的块数等） */
  diagnostics: { blocks: number; skipped: number };
}

/** 去 SRT/VTT 内联标签：<i> <b> <v Name> {\an8} 等 */
export function stripSubtitleTags(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSrt(input: string, opts: SubtitleParseOptions): SubtitleParseResult {
  const normalized = input.replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const evidence: Evidence[] = [];
  let skipped = 0;
  let seq = 0;

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // 找时间行（兼容缺失序号行）
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) {
      skipped++;
      continue;
    }
    const timeLine = lines[timeIdx];
    const m = timeLine.match(/^(\S+)\s*-->\s*(\S+)/);
    if (!m) {
      skipped++;
      continue;
    }
    const textLines = lines.slice(timeIdx + 1);
    const text = stripSubtitleTags(textLines.join(' '));
    if (!text) {
      skipped++;
      continue;
    }
    const tStartMs = parseTimestampToMs(m[1]);
    const tEndMs = parseTimestampToMs(m[2]);
    if (!(tEndMs > tStartMs)) {
      skipped++;
      continue;
    }
    evidence.push({
      id: `${opts.videoId}#${++seq}`,
      videoId: opts.videoId,
      seq,
      tStartMs,
      tEndMs,
      rawText: text,
      source: opts.source ?? 'subtitle',
    });
  }

  return { evidence, diagnostics: { blocks: blocks.length, skipped } };
}
