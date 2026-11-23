#!/usr/bin/env node
/**
 * 生成 srt-episode-map.json：每个新 SRT 集 → { bvid, offsetSec }。
 * 规则：
 *  - 旧语料句子（t_hms 对 B 站校准过）在同部的 SRT 流里定位 → 主落点集 + 偏移中位数
 *  - bvid 取主落点对应的旧集；偏移 |中位|≤15s 才套用（针灸14/15 等旧数据错误不套）
 *  - 没有旧集映射的新集（如本草 ep7/ep9）：bvid 留空、offset 0，标记 no-bvid
 * 输出: scripts/kb/srt-episode-map.json
 */
const fs = require('fs');
const path = require('path');
const pg = require('pg');
const SRT_DIR = process.env.SRT_DIR || '/Users/yangzhe/Downloads/字幕汇总';

const BOOKS = { '伤寒论': '01-shanghan', '金匮要略': '02-jinkui', '神农本草': '03-bencao', '黄帝内经': '04-neijing', '仲景心法': '05-zhongjing', '针灸': '06-zhenjiu' };

function fileToVideo(fname) {
  const m = fname.match(/^(伤寒论|金匮要略|神农本草|黄帝内经|仲景心法|针灸)(\d+)(?:-字幕版)?\.srt$/);
  if (!m) return null;
  return { book_id: BOOKS[m[1]], ep: parseInt(m[2], 10) };
}
function parseSrt(content) {
  const cues = []; const ts = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/;
  for (const b of content.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const lines = b.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => ts.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(ts);
    cues.push({ start: +m[1]*3600 + +m[2]*60 + +m[3] + (+m[4]/1000), text: lines.slice(ti+1).join('').trim() });
  }
  return cues;
}
const norm = (s) => s.replace(/[\s，。、！？：；「」『』“”‘’（）(),.:;!?'"《》\-—…·]/g, '');
const hms = (v) => { const p = v.split(':').map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

(async () => {
  // 1) 同部 SRT 索引
  const byBook = {};
  for (const f of fs.readdirSync(SRT_DIR)) {
    const v = fileToVideo(f); if (!v) continue;
    const cues = parseSrt(fs.readFileSync(path.join(SRT_DIR, f), 'utf8'));
    let stream = '', charCue = [];
    cues.forEach((c, ci) => { const n = norm(c.text); for (const ch of n) { stream += ch; charCue.push(ci); } });
    (byBook[v.book_id] = byBook[v.book_id] || []).push({ ...v, cues, stream, charCue });
  }

  // 2) 旧语料定位（只在同部内搜）
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const { rows } = await client.query('SELECT book_id, ep, t_hms, quote FROM corpus_entry ORDER BY book_id, ep, t_hms');
  const oldMeta = {}; // book → ep → bvid
  const bv = await client.query('SELECT book_id, ep, min(bvid) bvid FROM corpus_entry GROUP BY 1,2');
  bv.rows.forEach((r) => { (oldMeta[r.book_id] = oldMeta[r.book_id] || {})[r.ep] = r.bvid || ''; });

  // oldKey(book|ep) → Map(newEp → {n, offs[]})
  const vote = {};
  let unmatched = 0;
  for (const r of rows) {
    const q = norm(r.quote); if (q.length < 10) continue;
    const streams = byBook[r.book_id] || [];
    let hit = null;
    for (const v of streams) {
      const idx = v.stream.indexOf(q);
      if (idx >= 0) { hit = { ep: v.ep, srtSec: v.cues[v.charCue[idx]].start }; break; }
    }
    if (!hit) { unmatched++; continue; }
    const k = `${r.book_id}|${r.ep}`;
    const v = (vote[k] = vote[k] || {});
    const rec = (v[hit.ep] = v[hit.ep] || { n: 0, offs: [] });
    rec.n++; rec.offs.push(hit.srtSec - hms(r.t_hms));
  }
  await client.end();

  // 3) 汇总 per newEp
  const out = {};
  const log = [];
  for (const book of Object.keys(byBook).sort()) {
    out[book] = {};
    const newEps = byBook[book].map((v) => v.ep).sort((a, b) => a - b);
    for (const newEp of newEps) {
      // 找映射到这个新集的旧集（票数最高）
      let best = null;
      for (const [oldKey, m] of Object.entries(vote)) {
        if (!oldKey.startsWith(book + '|')) continue;
        const oldEp = Number(oldKey.split('|')[1]);
        if (m[newEp] && (!best || m[newEp].n > best.n)) best = { oldEp, ...m[newEp] };
      }
      if (best && best.n >= 5) {
        const off = med(best.offs);
        const applyOff = Math.abs(off) <= 15 ? Number(off.toFixed(1)) : 0;
        out[book][newEp] = {
          bvid: (oldMeta[book] || {})[best.oldEp] || '',
          offsetSec: applyOff,
          from: `old-ep${best.oldEp}`,
          n: best.n,
          offsetSkipped: Math.abs(off) > 15 ? Number(off.toFixed(0)) : undefined,
        };
      } else if (best) {
        // 命中太少，槽位兜底（同号新集）
        out[book][newEp] = { bvid: (oldMeta[book] || {})[newEp] || '', offsetSec: 0, from: `slot-fallback(weak n=${best.n})`, n: best.n };
      } else {
        // 没有任何旧内容落在此集：本草 ep7/ep9 等 → 无 bvid
        out[book][newEp] = { bvid: '', offsetSec: 0, from: 'no-old-coverage', n: 0 };
      }
    }
    for (const newEp of newEps) {
      const e = out[book][newEp];
      log.push(`${book} ep${String(newEp).padStart(2)}  bvid=${e.bvid || '(无)'}  offset=${e.offsetSec}s  ${e.from} (n=${e.n})${e.offsetSkipped ? ` [旧偏移 ${e.offsetSkipped}s 未套用]` : ''}`);
    }
  }
  fs.writeFileSync(path.resolve(process.cwd(), 'scripts/kb/srt-episode-map.json'), JSON.stringify(out, null, 1));
  console.log(log.join('\n'));
  console.log(`\n旧语料未匹配句数（跨部/缺失）: ${unmatched}/${rows.length}`);
  console.log('已写入 scripts/kb/srt-episode-map.json');
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
