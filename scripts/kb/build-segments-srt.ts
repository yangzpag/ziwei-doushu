#!/usr/bin/env tsx
/**
 * SRT 字幕 → 语义段落（kb_segment_new）。
 *
 * 管线：SRT cue 清洗 → 合并成句（句末标点/长停顿）→ 按强停顿聚块 →
 *       块向量（本地 embed-server）余弦相似度切分 → 启发式标题（条号/首句）→
 *       每集时间偏移校正（srt-episode-map.json，旧语料对 B 站校准）→ 段落 embedding → 入库。
 *
 *   DATABASE_URL=… EMBED_URL=http://127.0.0.1:3003 tsx scripts/kb/build-segments-srt.ts [--dry-run] \
 *     [--episode 01-shanghan:15] [--table kb_segment_new]
 *
 * 与旧 build-segments.ts 的差异：语料源从 corpus_entry（摘录+h2 标注）换成完整 SRT；
 * 话题边界从 h2 标注换成块间向量相似度；时间经每集中位偏移校正到 B 站时间轴。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const EMBED_DIM = 512;
const SRT_DIR = process.env.SRT_DIR || '/Users/yangzhe/Downloads/字幕汇总';
const MAP_PATH = path.resolve(process.cwd(), 'scripts/kb/srt-episode-map.json');

// ---- 可调参数 ----
const GAP_SENT = 2.0;        // cue 间静默 >2s 视为句子边界（口播换气）
const GAP_BLOCK = 3.5;       // >3.5s 视为强停顿（块边界候选）
const MAX_SENT_CUES = 40;    // 句子兜底长度（cue 数）
const SIM_CUT = 0.52;        // 块间余弦低于此值 → 切段
const SIM_SOFT = 0.60;       // 段落已超 SOFT_LEN 后低于此值也切
const SOFT_LEN = 550;        // 软上限（字）
const HARD_LEN = 1600;       // 硬上限（字，强制切）
const MIN_LEN = 120;         // 最短段（并入邻段）
const EMBED_INPUT_MAX = 900; // 块向量输入截断

const BOOKS: Record<string, string> = {
  伤寒论: '01-shanghan', 金匮要略: '02-jinkui', 神农本草: '03-bencao',
  黄帝内经: '04-neijing', 仲景心法: '05-zhongjing', 针灸: '06-zhenjiu',
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

interface Cue { start: number; end: number; text: string }

function parseSrt(content: string): Cue[] {
  const cues: Cue[] = [];
  const ts = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/;
  for (const b of content.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const lines = b.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => ts.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(ts)!;
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4] / 1000);
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + (+m[8] / 1000);
    const text = lines.slice(ti + 1).join(' ').replace(/\s+/g, ' ').trim();
    // 清洗：空行/纯音乐符号/纯标点
    if (!text || /^[♪♫♪.\-—…\s]+$/.test(text)) continue;
    cues.push({ start, end, text });
  }
  // 去相邻重复（同屏字幕跨 cue 重复）
  const dedup: Cue[] = [];
  for (const c of cues) {
    if (dedup.length && dedup[dedup.length - 1].text === c.text) {
      dedup[dedup.length - 1].end = c.end;
      continue;
    }
    dedup.push(c);
  }
  return dedup;
}

interface Sent { start: number; end: number; text: string; gapAfter: number; strongBreak: boolean }

/** cue → 句子（句末标点 / 停顿收口） */
function toSentences(cues: Cue[]): Sent[] {
  const sents: Sent[] = [];
  let buf: Cue[] = [];
  const flush = (strong: boolean, gapAfter: number) => {
    if (!buf.length) return;
    const text = buf.map((c) => c.text).reduce((acc, cur) => {
      const joiner = /[A-Za-z0-9)%]$/.test(acc) && /^[A-Za-z0-9(%]/.test(cur) ? ' ' : '';
      return acc + joiner + cur;
    }, '');
    sents.push({ start: buf[0].start, end: buf[buf.length - 1].end, text, gapAfter, strongBreak: strong });
    buf = [];
  };
  for (let i = 0; i < cues.length; i++) {
    buf.push(cues[i]);
    const next = cues[i + 1];
    const gap = next ? next.start - cues[i].end : Infinity;
    const ends = /[。？！?!]$/.test(cues[i].text);
    if (ends || gap > GAP_SENT || buf.length >= MAX_SENT_CUES) {
      flush(gap > GAP_BLOCK, Math.min(gap, 999));
    }
  }
  flush(true, 999);
  return sents;
}

interface Block { start: number; end: number; text: string; sents: number; strongStart: boolean; idx: number }

/** 句子 → 块（强停顿聚块；块内累计超 BLOCK_CAP 字也强制断，防巨型块切不动） */
function toBlocks(sents: Sent[]): Block[] {
  const BLOCK_CAP = 600;
  const blocks: Block[] = [];
  let cur: Sent[] = [];
  let curChars = 0;
  const flush = (strongNext: boolean) => {
    if (!cur.length) return;
    blocks.push({
      start: cur[0].start, end: cur[cur.length - 1].end,
      text: cur.map((s) => s.text).join(''),
      sents: cur.length, strongStart: strongNext, idx: blocks.length,
    });
    cur = [];
    curChars = 0;
  };
  for (const s of sents) {
    const strong = s.strongBreak;
    cur.push(s);
    curChars += s.text.length;
    if (strong || curChars > BLOCK_CAP) flush(strong);
  }
  flush(false);
  return blocks;
}

function hmsToSeconds(v: string): number {
  const p = v.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

/** 旧库人工标题词表（药名/条号/篇名），加载后按最长匹配用作新段标题 */
let oldVocab: string[] = [];

function displayTitle(text: string, used: Set<string>): string {
  // 1) 条号优先（字幕写法：「336条伤寒」「条336」「348-9这两个条」都抓第一个数字）
  const m = text.match(/(\d{1,3})(?:\s*[-－~—]\s*\d{1,4})?\s*(?:个|两|三)?\s*条/) || text.match(/条\s*(\d{1,3})/);
  if (m) {
    let t = `条${m[1]}`, n = 2;
    while (used.has(t)) { t = `条${m[1]}（续${n > 2 ? n - 1 : ''}）`; n++; }
    used.add(t);
    return t;
  }
  // 2) 旧库词表最长匹配（药名/方名/篇名；扫描段首 300 字）
  const head = text.slice(0, 300);
  let best = '';
  for (const v of oldVocab) {
    if (v.length >= 2 && v.length > best.length && head.includes(v)) best = v;
  }
  if (best) {
    let t = best, n = 2;
    while (used.has(t)) { t = `${best}（续${n > 2 ? n - 1 : ''}）`; n++; }
    used.add(t);
    return t;
  }
  // 3) 兜底：去句首口头语，取首句前 16 字
  let s = text.replace(/^(那么|这个|所以|然后|但是|我们再看|我们看|我们呢|我们|再来|还有|再来|接下来|好，?|那，?|啊|呢)+/, '').trim();
  s = s.slice(0, 16);
  s = s || text.slice(0, 16);
  let t = s, n = 2;
  while (used.has(t)) { t = `${s}（续${n > 2 ? n - 1 : ''}）`; n++; }
  used.add(t);
  return t;
}

async function embedTexts(texts: string[], embedUrl: string, retries = 3): Promise<number[][]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${embedUrl.replace(/\/$/, '')}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`embed-server ${res.status}`);
      const { vectors } = (await res.json()) as { vectors: number[][] };
      if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('返回数量不匹配');
      return vectors;
    } catch (e) {
      if (attempt === retries) throw e;
      console.warn(`  [embed] 重试 ${attempt + 1}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw new Error('unreachable');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

interface SegmentRow {
  segment_id: string; video_id: string; course_id: string; title: string; h2_full: string;
  text: string; start_seconds: number; end_seconds: number; bvid: string; ep: number; sentence_count: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) { console.error('缺少 DATABASE_URL'); process.exit(1); }
  const embedUrl = process.env.EMBED_URL ?? 'http://127.0.0.1:3003';
  const table = typeof args.table === 'string' ? args.table : 'kb_segment_new';
  if (!/^[a-z_0-9]+$/.test(table)) { console.error('非法表名'); process.exit(1); }
  const dryRun = args['dry-run'] === true;
  const episodeFilter = typeof args.episode === 'string' ? args.episode : undefined; // 01-shanghan:15

  const epMap: Record<string, Record<string, { bvid: string; offsetSec: number; from: string }>> =
    JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));

  // 1) 收集 SRT 文件
  const files = fs.readdirSync(SRT_DIR)
    .map((f) => {
      const m = f.match(/^(伤寒论|金匮要略|神农本草|黄帝内经|仲景心法|针灸)(\d+)(?:-字幕版)?\.srt$/);
      return m ? { f, course: BOOKS[m[1]], ep: parseInt(m[2], 10) } : null;
    })
    .filter((x): x is { f: string; course: string; ep: number } => !!x)
    .filter((x) => !episodeFilter || (x.course === episodeFilter.split(':')[0] && x.ep === Number(episodeFilter.split(':')[1])))
    .sort((a, b) => a.course.localeCompare(b.course) || a.ep - b.ep);

  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // 0) 旧库标题词表（若旧表还在）：药名/条号/篇名，用于新段标题
    try {
      const v = await client.query(`SELECT DISTINCT title FROM kb_segment`);
      oldVocab = [...new Set(v.rows.map((r) => r.title.replace(/（续[^）]*）/g, '')).filter((t) => t && t.length >= 2 && t.length <= 20))];
      console.log(`[词表] 旧库标题 ${oldVocab.length} 个（药名/条号/篇名）`);
    } catch { console.log('[词表] 旧库 kb_segment 不可读，跳过词表标题'); }

    // 2) 建目标表（幂等；重建时先删）
    const schema = fs.readFileSync(path.resolve(process.cwd(), 'scripts/kb/segments-schema.sql'), 'utf8')
      .replace(/kb_segment/g, table);
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.query(schema);

    let totalSegs = 0, embedCalls = 0;
    const allRows: SegmentRow[] = [];

    for (const { f, course, ep } of files) {
      const meta = epMap[course]?.[String(ep)];
      if (!meta) { console.warn(`  [skip] ${course} ep${ep} 无映射`); continue; }
      const cues = parseSrt(fs.readFileSync(path.join(SRT_DIR, f), 'utf8'));
      if (cues.length < 10) { console.warn(`  [skip] ${course} ep${ep} cue 过少(${cues.length})`); continue; }
      const sents = toSentences(cues);
      const blocks = toBlocks(sents);

      // 块向量（批量 64）
      const blockVecs: number[][] = [];
      for (let i = 0; i < blocks.length; i += 64) {
        const slice = blocks.slice(i, i + 64).map((b) => b.text.slice(0, EMBED_INPUT_MAX));
        const vecs = await embedTexts(slice, embedUrl);
        embedCalls++;
        blockVecs.push(...vecs);
      }

      // 块聚段：余弦低 → 切；软/硬上限保护
      type Seg = { blocks: typeof blocks; chars: number };
      const segs: Seg[] = [];
      let cur: Seg = { blocks: [], chars: 0 };
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (cur.blocks.length) {
          const sim = cosine(blockVecs[i - 1], blockVecs[i]);
          const mustCut =
            sim < SIM_CUT ||
            cur.chars > HARD_LEN - 400 ||                       // 接近硬上限，见好就收
            (cur.chars > SOFT_LEN && sim < SIM_SOFT) ||
            cur.chars > HARD_LEN;
          const strongAndLong = b.strongStart && cur.chars > SOFT_LEN; // 强停顿+已够长
          if (mustCut || strongAndLong) { segs.push(cur); cur = { blocks: [], chars: 0 }; }
        }
        cur.blocks.push(b);
        cur.chars += b.text.length;
      }
      if (cur.blocks.length) segs.push(cur);

      // 短段并入邻段
      const mergeShort = (arr: Seg[]): Seg[] => {
        const out: Seg[] = [];
        for (const s of arr) {
          const prev = out[out.length - 1];
          const nextLong = s.chars >= MIN_LEN;
          if (prev && (s.chars < MIN_LEN || prev.chars < MIN_LEN) && prev.chars + s.chars <= HARD_LEN) {
            prev.blocks.push(...s.blocks);
            prev.chars += s.chars;
          } else if (!nextLong && out.length === 0) {
            out.push(s); // 开头就超短，先保留（会被下一段合并）
          } else {
            out.push(s);
          }
        }
        // 第二遍：向后吸收残留短段
        for (let i = out.length - 1; i > 0; i--) {
          if (out[i].chars < MIN_LEN && out[i - 1].chars + out[i].chars <= HARD_LEN) {
            out[i - 1].blocks.push(...out[i].blocks);
            out[i - 1].chars += out[i].chars;
            out.splice(i, 1);
          }
        }
        return out;
      };
      // 超硬上限：在段内最低相似度的块边界切（不在话题中间乱切）
      const splitLong = (arr: Seg[]): Seg[] => {
        const out: Seg[] = [];
        for (const seg of arr) {
          if (seg.chars <= HARD_LEN || seg.blocks.length < 2) { out.push(seg); continue; }
          let rest = seg.blocks;
          while (rest.length > 1) {
            const total = rest.reduce((s, b) => s + b.text.length, 0);
            if (total <= HARD_LEN) break;
            let worst = 1, worstSim = Infinity;
            for (let j = 1; j < rest.length; j++) {
              const sim = cosine(blockVecs[rest[j - 1].idx], blockVecs[rest[j].idx]);
              if (sim < worstSim) { worstSim = sim; worst = j; }
            }
            out.push({ blocks: rest.slice(0, worst), chars: rest.slice(0, worst).reduce((s, b) => s + b.text.length, 0) });
            rest = rest.slice(worst);
          }
          out.push({ blocks: rest, chars: rest.reduce((s, b) => s + b.text.length, 0) });
        }
        return out;
      };
      const merged = mergeShort(splitLong(mergeShort(segs)));

      // 组装段落行
      const usedTitles = new Set<string>();
      const videoId = `${course}-ep${ep}`;
      let no = 0;
      for (const seg of merged) {
        no++;
        const text = seg.blocks.map((b) => b.text).join('');
        const first = seg.blocks[0].text;
        const row: SegmentRow = {
          segment_id: `${videoId}-s${String(no).padStart(3, '0')}`,
          video_id: videoId,
          course_id: course,
          title: displayTitle(first, usedTitles),
          h2_full: first.slice(0, 200),
          text,
          start_seconds: Math.max(0, seg.blocks[0].start + meta.offsetSec),
          end_seconds: Math.max(1, seg.blocks[seg.blocks.length - 1].end + meta.offsetSec),
          bvid: meta.bvid,
          ep,
          sentence_count: seg.blocks.reduce((s, b) => s + b.sents, 0),
        };
        allRows.push(row);
      }
      if (!dryRun || allRows.length <= 5) {
        console.log(`  ${course} ep${ep}: ${cues.length} cue → ${sents.length} 句 → ${blocks.length} 块 → ${merged.length} 段 (bvid=${meta.bvid ? '有' : '无'}, off=${meta.offsetSec}s)`);
      }
    }

    // 3) 统计
    const lens = allRows.map((s) => s.text.length).sort((a, b) => a - b);
    const totalChars = allRows.reduce((s, x) => s + x.text.length, 0);
    const withBvid = allRows.filter((s) => s.bvid).length;
    console.log(`\n[统计] ${allRows.length} 段 | ${totalChars} 字 | 段长中位 ${lens[Math.floor(lens.length / 2)]} | 最短 ${lens[0]} | 最长 ${lens[lens.length - 1]} | 有 bvid: ${withBvid}/${allRows.length}`);
    if (dryRun) {
      console.log('\n[dry-run] 前 8 段样例:');
      for (const s of allRows.slice(0, 8)) {
        console.log(`  ${s.segment_id} 「${s.title}」 ${s.start_seconds.toFixed(0)}→${s.end_seconds.toFixed(0)}s ${s.text.length}字: ${s.text.slice(0, 50)}…`);
      }
      await client.end();
      return;
    }

    // 4) 入库 + 段落 embedding
    console.log('\n[embedding + 入库]...');
    const BATCH = 32;
    for (let i = 0; i < allRows.length; i += BATCH) {
      const slice = allRows.slice(i, i + BATCH);
      const vecs = await embedTexts(slice.map((s) => `${s.title}：${s.text}`.slice(0, 1800)), embedUrl);
      embedCalls++;
      for (let j = 0; j < slice.length; j++) {
        const s = slice[j];
        await client.query(
          `INSERT INTO ${table} (segment_id, video_id, course_id, title, h2_full, text, start_seconds, end_seconds, bvid, ep, sentence_count, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)`,
          [s.segment_id, s.video_id, s.course_id, s.title, s.h2_full, s.text, s.start_seconds, s.end_seconds, s.bvid, s.ep, s.sentence_count, `[${vecs[j].join(',')}]`]
        );
      }
      if ((i / BATCH) % 20 === 0) console.log(`  ${Math.min(i + BATCH, allRows.length)}/${allRows.length} 段…`);
    }
    totalSegs = allRows.length;
    console.log(`\n[完成] ${totalSegs} 段入库到 ${table}（embed ${embedCalls} 批）`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('[srt-segments] 失败:', e); process.exit(1); });
