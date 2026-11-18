#!/usr/bin/env node
/**
 * 校验 SRT 字幕时间与旧语料时间（对 B 站视频校准过）是否对齐。
 * 方法：旧语料每句在 SRT cue 流里做归一化子串匹配，取命中 cue 的开始时间，
 *       与旧 t_hms 求差；按 (book, ep) 统计偏移分布。
 * 只读本地文件 + 本地查询（需 DATABASE_URL 读旧语料），不写任何东西。
 */
const fs = require('fs');
const path = require('path');
const pg = require('pg');

const SRT_DIR = process.env.SRT_DIR || '/Users/yangzhe/Downloads/字幕汇总';

/** 文件名 → (book_id, ep) */
function fileToVideo(fname) {
  const m = fname.match(/^(伤寒论|金匮要略|神农本草|黄帝内经|仲景心法|针灸)(\d+)(?:-字幕版)?\.srt$/);
  if (!m) return null;
  const book = { '伤寒论': '01-shanghan', '金匮要略': '02-jinkui', '神农本草': '03-bencao', '黄帝内经': '04-neijing', '仲景心法': '05-zhongjing', '针灸': '06-zhenjiu' }[m[1]];
  return { book_id: book, ep: parseInt(m[2], 10) };
}

/** 解析 SRT → [{start,end,text}]（秒） */
function parseSrt(content) {
  const cues = [];
  const blocks = content.replace(/\r\n/g, '\n').split(/\n\n+/);
  const ts = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/;
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => ts.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(ts);
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4] / 1000);
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + (+m[8] / 1000);
    const text = lines.slice(ti + 1).join('');
    if (text.trim()) cues.push({ start, end, text: text.trim() });
  }
  return cues;
}

/** 归一化：去空白和常见标点 */
const norm = (s) => s.replace(/[\s，。、！？：；「」『』""''（）(),.:;!?'"《》\-—…·]/g, '');

function main() {
  // 1) 读全部 SRT，建归一化文本流 + 字符→cue 映射
  const videos = {}; // key: book|ep → {cues, stream, charCue}
  for (const f of fs.readdirSync(SRT_DIR)) {
    const v = fileToVideo(f);
    if (!v) continue;
    const cues = parseSrt(fs.readFileSync(path.join(SRT_DIR, f), 'utf8'));
    let stream = '', charCue = [];
    cues.forEach((c, ci) => {
      const n = norm(c.text);
      for (const ch of n) { stream += ch; charCue.push(ci); }
    });
    videos[`${v.book_id}|${v.ep}`] = { cues, stream, charCue };
  }

  // 2) 查旧语料，逐句匹配
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  client.connect().then(async () => {
    const { rows } = await client.query(
      `SELECT book_id, ep, t_hms, quote FROM corpus_entry
        WHERE book_id IN ('01-shanghan','02-jinkui','03-bencao','04-neijing','05-zhongjing','06-zhenjiu')
        ORDER BY book_id, ep, t_hms`);
    const hms = (v) => { const p = v.split(':').map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; };

    // stats: book|ep → {matched, total, offsets[]}
    const stats = {};
    for (const r of rows) {
      const key = `${r.book_id}|${r.ep}`;
      const v = videos[key];
      const st = (stats[key] = stats[key] || { matched: 0, total: 0, offsets: [] });
      st.total++;
      if (!v) continue;
      const q = norm(r.quote);
      if (q.length < 6) continue; // 太短的没鉴别力
      const idx = v.stream.indexOf(q);
      if (idx < 0) continue;
      const cue = v.cues[v.charCue[idx]];
      if (!cue) continue;
      st.matched++;
      st.offsets.push(cue.start - hms(r.t_hms));
    }
    await client.end();

    // 3) 汇总输出
    const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : '—';
    const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const p95 = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
    console.log('book              ep   匹配率    句数   偏移中位(秒)  |偏移|p95   判定');
    for (const key of Object.keys(stats).sort()) {
      const [b, e] = key.split('|');
      const st = stats[key];
      const med0 = med(st.offsets);
      const spread = st.offsets.length ? Math.max(...st.offsets.map(Math.abs)) : NaN;
      const p95a = p95(st.offsets.map(Math.abs));
      let verdict;
      if (!st.matched) verdict = '无法比对(无命中)';
      else if (Math.abs(med0) <= 2 && p95a <= 3) verdict = '✓ 对齐';
      else if (p95a <= 3) verdict = `✓ 对齐(整体偏 ${med0 > 0 ? '+' : ''}${med0.toFixed(1)}s 可校正)`;
      else if (st.offsets.every((o) => Math.abs(o - med0) <= 3)) verdict = `⚠ 固定偏移 ${med0.toFixed(1)}s（可统一校正）`;
      else verdict = '✗ 时间对不上（来源不同）';
      console.log(`${b.padEnd(16)} ${String(e).padStart(3)}  ${pct(st.matched, st.total).padStart(5)}   ${String(st.matched).padStart(5)}   ${(isNaN(med0)?'—':med0.toFixed(1)).padStart(9)}   ${(isNaN(p95a)?'—':p95a.toFixed(1)).padStart(7)}   ${verdict}`);
    }
  }).catch((e) => { console.error('ERR:', e.message); process.exit(1); });
}
main();
