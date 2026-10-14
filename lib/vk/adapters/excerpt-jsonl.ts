/**
 * 摘录 JSONL 适配器（nihai-renji-corpus / nihai-tianji-corpus）。
 *
 * 语料是「短引文 + 出处时间」的零散摘录，不是完整逐字稿：
 * - 每条只有起始时间 t_hms，结束时间一律留空（禁用下一条摘录的时间冒充）；
 * - mode 固定为 'excerpt'，全链路不得冒充完整逐字稿；
 * - 按 book + ep 聚合成视频，videoId = `${book}-ep${ep}`（稳定可溯源）。
 */
import type { Evidence, TranscriptMode, VideoMeta } from '../types';
import { parseTimestampToMs } from '../timeline';

export interface ExcerptRow {
  book?: string;
  part_name?: string;
  h2?: string;
  h3?: string;
  quote?: string;
  bvid?: string;
  ep?: number;
  part?: number;
  section?: number;
  t_hms?: string;
  source_file?: string;
  note?: string;
}

export interface ExcerptParseOptions {
  /** 内容类型配置 id（缺省由调用方决定） */
  contentType?: string;
  /** 按课程（book）覆盖内容类型，如 { '03-bencao': 'shennong-bencao' } */
  contentTypeByBook?: Record<string, string>;
  /** 只导入这些视频（videoId） */
  onlyVideoIds?: string[];
  /** 最多导入多少个视频（小样本运行） */
  limitVideos?: number;
  importVersion?: string;
}

export const EXCERPT_LICENSE = 'CC BY-NC-SA 4.0';
export const EXCERPT_SOURCE = 'nihai-renji-corpus (github.com/Renhuai123/nihai-renji-corpus)';

export interface ExcerptParseResult {
  videos: VideoMeta[];
  evidence: Evidence[];
  diagnostics: {
    rows: number;
    badRows: number;
    videos: number;
    perVideo: Record<string, number>;
  };
}

export function parseExcerptJsonl(
  input: string,
  opts: ExcerptParseOptions = {}
): ExcerptParseResult {
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  const importVersion = opts.importVersion ?? 'v1';

  interface Acc {
    rows: ExcerptRow[];
    lineIdx: number[];
  }
  const byVideo = new Map<string, Acc>();
  let badRows = 0;

  lines.forEach((line, i) => {
    let row: ExcerptRow;
    try {
      row = JSON.parse(line) as ExcerptRow;
    } catch {
      badRows++;
      return;
    }
    if (!row.book || !row.quote || row.ep === undefined) {
      badRows++;
      return;
    }
    const videoId = `${row.book}-ep${row.ep}`;
    if (!byVideo.has(videoId)) byVideo.set(videoId, { rows: [], lineIdx: [] });
    const acc = byVideo.get(videoId)!;
    acc.rows.push(row);
    acc.lineIdx.push(i);
  });

  const videos: VideoMeta[] = [];
  const evidence: Evidence[] = [];
  const perVideo: Record<string, number> = {};

  const videoIds = [...byVideo.keys()].sort();
  for (const videoId of videoIds) {
    if (opts.onlyVideoIds && !opts.onlyVideoIds.includes(videoId)) continue;
    if (opts.limitVideos !== undefined && videos.length >= opts.limitVideos) break;

    const acc = byVideo.get(videoId)!;
    // 稳定排序：时间升序，同时间按原始行号（可复现）
    const order = acc.rows
      .map((row, i) => ({ row, line: acc.lineIdx[i] }))
      .sort((a, b) => {
        const ta = safeHms(a.row.t_hms);
        const tb = safeHms(b.row.t_hms);
        if (ta !== tb) return ta - tb;
        return a.line - b.line;
      });

    const first = order[0].row;
    videos.push({
      videoId,
      courseId: first.book!,
      courseName: first.part_name || first.book!,
      bvid: first.bvid || '',
      cid: null,
      part: first.part && first.part > 1 ? first.part : 1,
      title: `${first.part_name || first.book} 第 ${first.ep} 集`,
      mode: 'excerpt',
      contentType:
        opts.contentTypeByBook?.[first.book!] ?? opts.contentType ?? 'book-commentary',
      license: EXCERPT_LICENSE,
      source: EXCERPT_SOURCE,
      importVersion,
    });

    order.forEach((entry, i) => {
      const r = entry.row;
      const meta: Record<string, string | number> = {};
      if (r.h2) meta.h2 = r.h2;
      if (r.h3) meta.h3 = r.h3;
      if (r.section !== undefined) meta.section = r.section;
      if (r.source_file) meta.sourceFile = r.source_file;
      if (r.note) meta.note = r.note;
      evidence.push({
        id: `${videoId}#${i + 1}`,
        videoId,
        seq: i + 1,
        tStartMs: safeHms(r.t_hms),
        // 摘录只有起始时间：结束时间留空
        tEndMs: null,
        rawText: r.quote!,
        source: 'excerpt',
        meta,
      });
    });
    perVideo[videoId] = order.length;
  }

  return {
    videos,
    evidence,
    diagnostics: { rows: lines.length, badRows, videos: videos.length, perVideo },
  };
}

function safeHms(v: string | undefined): number {
  if (!v) return 0;
  try {
    return parseTimestampToMs(v);
  } catch {
    return 0;
  }
}

/** 供 build-glossary 等工具复用：从摘录行提取候选术语（h2 主名） */
export function extractExcerptTerms(input: string): { term: string; count: number }[] {
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const line of lines) {
    let row: ExcerptRow;
    try {
      row = JSON.parse(line) as ExcerptRow;
    } catch {
      continue;
    }
    if (!row.h2) continue;
    // 「恒山 / 蜀漆 / 常山（口称…）」→ 多术语；「半夏（下品草部…）」→ 半夏
    const head = row.h2.split(/[（(]/)[0];
    for (const piece of head.split(/[／/]/)) {
      const term = piece.trim();
      if (term.length >= 2) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

export type { TranscriptMode };
