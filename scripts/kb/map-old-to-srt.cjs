#!/usr/bin/env node
/**
 * 完整对照表：每个旧 (book,ep) 的句子多数落在哪个新 SRT 集 + 时间偏移中位数。
 * 输出 oldEp → newEp 映射与偏移，标出新 SRT 集里旧语料没覆盖的。
 */
const fs = require('fs');
const path = require('path');
const pg = require('pg');
const SRT_DIR = process.env.SRT_DIR || '/Users/yangzhe/Downloads/字幕汇总';

function fileToVideo(fname) {
  const m = fname.match(/^(伤寒论|金匮要略|神农本草|黄帝内经|仲景心法|针灸)(\d+)(?:-字幕版)?\.srt$/);
  if (!m) return null;
  const book = { '伤寒论':'01-shanghan','金匮要略':'02-jinkui','神农本草':'03-bencao','黄帝内经':'04-neijing','仲景心法':'05-zhongjing','针灸':'06-zhenjiu' }[m[1]];
  return { book_id: book, ep: parseInt(m[2], 10) };
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
const norm = (s) => s.replace(/[\s，。、！？：；「」『』""''（）(),.:;!?'"《》\-—…·]/g, '');
const hms = (v) => { const p = v.split(':').map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; };

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
client.connect().then(async () => {
  const all = [];
  for (const f of fs.readdirSync(SRT_DIR)) {
    const v = fileToVideo(f); if (!v) continue;
    const cues = parseSrt(fs.readFileSync(path.join(SRT_DIR, f), 'utf8'));
    let stream = '', charCue = [];
    cues.forEach((c, ci) => { const n = norm(c.text); for (const ch of n) { stream += ch; charCue.push(ci); } });
    all.push({ ...v, cues, stream, charCue });
  }
  const { rows } = await client.query('SELECT book_id, ep, t_hms, quote FROM corpus_entry ORDER BY book_id, ep, t_hms');
  // oldKey → Map(newKey → {n, offsets[]})
  const map = {};
  for (const r of rows) {
    const q = norm(r.quote); if (q.length < 10) continue;
    const oldKey = `${r.book_id}|ep${r.ep}`;
    const st = (map[oldKey] = map[oldKey] || {});
    for (const v of all) {
      const idx = v.stream.indexOf(q);
      if (idx >= 0) {
        const nk = `${v.book_id}|ep${v.ep}`;
        const rec = (st[nk] = st[nk] || { n: 0, offs: [] });
        rec.n++; rec.offs.push(v.cues[v.charCue[idx]].start - hms(r.t_hms));
        break; // 命中第一个（集内先试？这里全集扫，第一命中即止——同文本可能多集出现，取第一个可能不准，但主讲内容唯一）
      }
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log('旧集                    → 主落点            句数   偏移中位   判定');
  const bookTotals = {};
  for (const oldKey of Object.keys(map).sort()) {
    const st = map[oldKey];
    const entries = Object.entries(st).sort((a, b) => b[1].n - a[1].n);
    const [bk, oldep] = oldKey.split('|');
    bookTotals[bk] = bookTotals[bk] || { covered: new Set(), rows: [] };
    if (!entries.length) { bookTotals[bk].rows.push(`${oldKey.padEnd(20)} → (全集无命中)`); continue; }
    const [nk, rec] = entries[0];
    const sameBook = nk.startsWith(bk);
    const off = med(rec.offs);
    const align = sameBook && nk === oldKey ? (Math.abs(off) <= 3 ? '✓ 同集对齐' : `⚠ 同集偏 ${off.toFixed(1)}s`) : (sameBook ? `→ 错位到 ${nk.split('|')[1]}（偏 ${off.toFixed(1)}s）` : `→ 落在别的部 ${nk}`);
    bookTotals[bk].covered.add(nk);
    bookTotals[bk].rows.push(`${oldKey.padEnd(20)} → ${nk.padEnd(18)} ${String(rec.n).padStart(4)}   ${off.toFixed(1).padStart(7)}   ${align}`);
  }
  // 新 SRT 里旧语料没覆盖的集
  for (const bk of Object.keys(bookTotals).sort()) {
    console.log(`\n########## ${bk} ##########`);
    bookTotals[bk].rows.forEach((r) => console.log(r));
  }
  await client.end();
}).catch((e) => { console.error('ERR:', e.message); process.exit(1); });
