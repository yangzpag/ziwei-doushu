/**
 * 适配器入口：格式探测 + 统一分发。
 *
 * 输入可以是完整字幕（SRT/VTT/JSON）或摘录库（JSONL），
 * 输出统一的 VideoMeta + Evidence，后续阶段不关心来源格式。
 */
import type { Evidence, VideoMeta } from '../types';
import { parseSrt, type SubtitleParseOptions } from './srt';
import { parseVtt } from './vtt';
import { parseSubtitleJson } from './subtitle-json';
import { parseExcerptJsonl, type ExcerptParseOptions } from './excerpt-jsonl';

export type InputFormat = 'srt' | 'vtt' | 'subtitle-json' | 'excerpt-jsonl' | 'auto';

export interface SubtitleSourceInput extends SubtitleParseOptions {
  format: InputFormat;
  /** 文件名（辅助探测） */
  filename?: string;
}

export interface SubtitleSourceResult {
  videos: VideoMeta[];
  evidence: Evidence[];
  diagnostics: Record<string, unknown>;
}

/** 依据文件名与内容探测格式 */
export function detectFormat(content: string, filename?: string): InputFormat {
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.srt')) return 'srt';
  if (name.endsWith('.vtt')) return 'vtt';
  if (name.endsWith('.jsonl') || name.endsWith('.json')) {
    const head = content.slice(0, 4000);
    // 摘录库特征字段
    if (/"(quote|bvid|part_name)"\s*:/.test(head)) return 'excerpt-jsonl';
    return 'subtitle-json';
  }
  const head = content.slice(0, 200).trim();
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(content)) return 'srt';
  if (/-->/.test(head) && /\d{2}:\d{2}:\d{2}\.\d{3}/.test(head)) return 'vtt';
  if (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) {
    if (/"(quote|bvid)"\s*:/.test(content.slice(0, 4000))) return 'excerpt-jsonl';
    return 'subtitle-json';
  }
  return 'srt';
}

/** 完整字幕类输入（单视频） */
export function loadSubtitleSource(
  content: string,
  video: Omit<VideoMeta, 'mode' | 'license' | 'source' | 'importVersion'> &
    Partial<Pick<VideoMeta, 'mode' | 'license' | 'source' | 'importVersion'>>,
  input: SubtitleSourceInput
): SubtitleSourceResult {
  const format = input.format === 'auto' ? detectFormat(content, input.filename) : input.format;
  let evidence: Evidence[];
  let diagnostics: Record<string, unknown>;

  if (format === 'srt') {
    const r = parseSrt(content, { videoId: video.videoId, source: 'subtitle' });
    evidence = r.evidence;
    diagnostics = r.diagnostics;
  } else if (format === 'vtt') {
    const r = parseVtt(content, { videoId: video.videoId, source: 'subtitle' });
    evidence = r.evidence;
    diagnostics = r.diagnostics;
  } else if (format === 'subtitle-json') {
    const r = parseSubtitleJson(content, { videoId: video.videoId, source: 'subtitle' });
    evidence = r.evidence;
    diagnostics = r.diagnostics;
  } else {
    throw new Error(`${format} 不是完整字幕格式，请走 loadExcerptSource`);
  }

  const meta: VideoMeta = {
    ...video,
    mode: video.mode ?? 'full_transcript',
    license: video.license ?? '',
    source: video.source ?? (input.filename ?? 'subtitle'),
    importVersion: video.importVersion ?? 'v1',
  };
  return { videos: [meta], evidence, diagnostics: { format, ...diagnostics } };
}

/** 摘录库输入（多视频聚合） */
export function loadExcerptSource(
  content: string,
  opts: ExcerptParseOptions & { format?: InputFormat; filename?: string }
): SubtitleSourceResult {
  const format = opts.format && opts.format !== 'auto' ? opts.format : detectFormat(content, opts.filename);
  if (format !== 'excerpt-jsonl') {
    throw new Error(`摘录加载器只接受 excerpt-jsonl，收到 ${format}`);
  }
  const r = parseExcerptJsonl(content, opts);
  return {
    videos: r.videos,
    evidence: r.evidence,
    diagnostics: { format, ...r.diagnostics },
  };
}
