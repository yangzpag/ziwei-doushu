/**
 * VTT 适配器：WebVTT 文本 → 统一 Evidence 列表。
 *
 * 与 SRT 的差异：时间戳用小数点、有 WEBVTT 头、可有 cue id / 行内设置。
 */
import type { Evidence, EvidenceKind } from '../types';
import { parseTimestampToMs } from '../timeline';
import { stripSubtitleTags, type SubtitleParseOptions, type SubtitleParseResult } from './srt';

export function parseVtt(input: string, opts: SubtitleParseOptions): SubtitleParseResult {
  const normalized = input.replace(/\r\n?/g, '\n');
  // 按空行分块，跳过 WEBVTT 头与 NOTE/STYLE 块
  const blocks = normalized.split(/\n{2,}/);
  const evidence: Evidence[] = [];
  let skipped = 0;
  let seq = 0;

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines[0] === 'WEBVTT' || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) {
      continue;
    }
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
    const text = stripSubtitleTags(lines.slice(timeIdx + 1).join(' '));
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
