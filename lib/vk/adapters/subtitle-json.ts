/**
 * 字幕 JSON / JSONL 适配器。
 *
 * 接受：
 * - JSON 数组：[{start, end, text}, ...]
 * - JSON 对象包裹：{cues: [...]} / {subtitles: [...]}
 * - JSONL：每行一个 {start, end, text}
 *
 * 时间字段兼容 start/tStart/startMs/begin 与 end/tEnd/endMs/finish，
 * 值兼容秒数 / 毫秒 / 'HH:MM:SS(.mmm)' / [秒, 毫秒]。
 * end 缺失时留空（不用下一条冒充）。
 */
import type { Evidence, EvidenceKind } from '../types';
import { parseTimestampToMs } from '../timeline';
import { stripSubtitleTags, type SubtitleParseOptions, type SubtitleParseResult } from './srt';

interface RawCue {
  start?: unknown;
  end?: unknown;
  tStart?: unknown;
  tEnd?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  begin?: unknown;
  finish?: unknown;
  text?: unknown;
  content?: unknown;
  subtitle?: unknown;
}

function pickTime(v: unknown, msMode = false): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) {
    const [s, ms] = v as [number, number];
    return Math.round(s * 1000 + (ms ?? 0));
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return Math.round(v * 1000);
    return msMode ? v : v * 1000;
  }
  if (typeof v === 'string') return parseTimestampToMs(v);
  return null;
}

/** 文件级单位探测：存在 ≥86400 的整数值时判为毫秒制（字幕秒数不可能超过 24 小时） */
function detectMsMode(cues: RawCue[]): boolean {
  for (const cue of cues) {
    for (const key of ['start', 'tStart', 'startMs', 'begin'] as const) {
      const v = cue[key];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 86_400) return true;
    }
  }
  return false;
}

export function parseSubtitleCues(cues: RawCue[], opts: SubtitleParseOptions): SubtitleParseResult {
  const evidence: Evidence[] = [];
  let skipped = 0;
  let seq = 0;
  const msMode = detectMsMode(cues);

  for (const cue of cues) {
    if (!cue || typeof cue !== 'object') {
      skipped++;
      continue;
    }
    const text = stripSubtitleTags(
      String(cue.text ?? cue.content ?? cue.subtitle ?? '')
    );
    const tStartMs = pickTime(cue.start ?? cue.tStart ?? cue.startMs ?? cue.begin, msMode);
    const tEndMs = pickTime(cue.end ?? cue.tEnd ?? cue.endMs ?? cue.finish, msMode);
    if (!text || tStartMs === null) {
      skipped++;
      continue;
    }
    if (tEndMs !== null && !(tEndMs > tStartMs)) {
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

  return { evidence, diagnostics: { blocks: cues.length, skipped } };
}

/** JSON / JSONL 入口：自动识别包裹结构 */
export function parseSubtitleJson(input: string, opts: SubtitleParseOptions): SubtitleParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { evidence: [], diagnostics: { blocks: 0, skipped: 0 } };

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 可能是 JSONL：逐行解析
      return parseSubtitleJsonl(trimmed, opts);
    }
    const cues = Array.isArray(parsed)
      ? (parsed as RawCue[])
      : ((parsed as { cues?: RawCue[]; subtitles?: RawCue[] }).cues ??
        (parsed as { subtitles?: RawCue[] }).subtitles);
    if (!Array.isArray(cues)) {
      return { evidence: [], diagnostics: { blocks: 0, skipped: 1 } };
    }
    return parseSubtitleCues(cues, opts);
  }
  return parseSubtitleJsonl(trimmed, opts);
}

function parseSubtitleJsonl(input: string, opts: SubtitleParseOptions): SubtitleParseResult {
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  const cues: RawCue[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      cues.push(JSON.parse(line) as RawCue);
    } catch {
      skipped++;
    }
  }
  const result = parseSubtitleCues(cues, opts);
  return { ...result, diagnostics: { ...result.diagnostics, skipped: result.diagnostics.skipped + skipped } };
}
