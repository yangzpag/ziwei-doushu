#!/usr/bin/env node
/** 跨集定位：旧语料里在"本集 SRT"找不到的句子，去全部 121 个 SRT 里搜，报告实际落在哪一集。 */
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

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
client.connect().then(async () => {
  // 建 121 个 SRT 的索引
  const all = [];
  for (const f of fs.readdirSync(SRT_DIR)) {
    const v = fileToVideo(f); if (!v) continue;
    const cues = parseSrt(fs.readFileSync(path.join(SRT_DIR, f), 'utf8'));
    let stream = '', charCue = [];
    cues.forEach((c, ci) => { const n = norm(c.text); for (const ch of n) { stream += ch; charCue.push(ci); } });
    all.push({ ...v, cues, stream, charCue });
  }
  // 查"目标集"的旧语料句子，跨全集搜索
  const targets = process.env.TARGET || '03-bencao|7,8,9,10,11,12,13,14;02-jinkui|6';
  for (const seg of targets.split(';')) {
    const [book, eps] = seg.split('|');
    const { rows } = await client.query(
      'SELECT ep, t_hms, quote FROM corpus_entry WHERE book_id=$1 AND ep = ANY($2::int[]) ORDER BY ep, t_hms',
      [book, eps.split(',').map(Number)]);
    const found = {}; // oldEp → Map(newKey → count)
    let hit = 0, miss = 0;
    for (const r of rows) {
      const q = norm(r.quote); if (q.length < 10) continue;
      let located = null;
      for (const v of all) {
        const idx = v.stream.indexOf(q);
        if (idx >= 0) { located = `${v.book_id}|ep${v.ep}@${v.cues[v.charCue[idx]].start.toFixed(0)}s`; break; }
      }
      if (located) { hit++; const k = `旧ep${r.ep} → ${located}`; found[k] = (found[k] || 0) + 1; }
      else miss++;
    }
    console.log(`\n=== ${book} ${eps}（命中 ${hit}，未找到 ${miss}）===`);
    Object.entries(found).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, c]) => console.log(`  ${String(c).padStart(4)} 句  ${k}`));
  }
  await client.end();
}).catch((e) => { console.error('ERR:', e.message); process.exit(1); });
