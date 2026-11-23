#!/usr/bin/env node
/**
 * 标题增强 v2：旧语料 h2 标签按时间对齐继承给新段落。
 * 区间模型：标签 span = [本标签最早 t_hms, 下一标签最早 t_hms)（插值，比采样跨度准）。
 * 选标签：与段区间重叠时长最大者（平手取更早 t0）。
 * 只替换兜底标题（非条号、非旧词表），条号/词表标题保留。
 * 用法: node enrich-titles.cjs [--course 01-shanghan]   必须在删 corpus_entry 之前跑
 */
const pg = require('pg');

(async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  // 1) 旧词表（与 builder 同判定）
  const vocab = new Set((await client.query(`SELECT DISTINCT title FROM kb_segment`)).rows
    .map((r) => r.title.replace(/（续[^）]*）/g, '')).filter((t) => t && t.length >= 2 && t.length <= 20));
  // 2) 旧 h2 标签（B 站时间轴，秒）
  const labels = (await client.query(
    `SELECT book_id, ep, h2, count(*) n,
            (array_agg(t_hms ORDER BY t_hms))[1] AS t0
       FROM corpus_entry GROUP BY book_id, ep, h2`)).rows;
  const hms = (v) => { const p = v.split(':').map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; };
  const byVideo = {};
  for (const l of labels) {
    (byVideo[`${l.book_id}|${l.ep}`] = byVideo[`${l.book_id}|${l.ep}`] || []).push({ h2: l.h2, t0: hms(l.t0), n: Number(l.n) });
  }
  // 插值 span：[t0_i, t0_{i+1})，末位 [t0, +∞) 但截断到 3600s
  for (const key of Object.keys(byVideo)) {
    const arr = byVideo[key].sort((a, b) => a.t0 - b.t0);
    arr.forEach((l, i) => {
      const nextT0 = i + 1 < arr.length ? arr[i + 1].t0 : l.t0 + 3600;
      l.spanEnd = Math.min(nextT0, l.t0 + 3600);
    });
  }
  // 3) 逐段判定（--course 可分批）
  const courseFilter = process.argv[2] ? process.argv[2].replace('--course=', '') : null;
  const segs = (await client.query(
    `SELECT segment_id, course_id, ep, title, start_seconds, end_seconds FROM kb_segment_new ${courseFilter ? 'WHERE course_id=$1' : ''}`,
    courseFilter ? [courseFilter] : [])).rows;
  let replaced = 0, kept = 0, noLabel = 0;
  for (const s of segs) {
    const isTiao = /^条\d{1,3}/.test(s.title);
    const inVocab = vocab.has(s.title.replace(/（续[^）]*）/g, ''));
    if (isTiao || inVocab) { kept++; continue; }
    const pool = byVideo[`${s.course_id}|${s.ep}`] || [];
    let best = null;
    for (const l of pool) {
      const ov = Math.min(l.spanEnd, s.end_seconds) - Math.max(l.t0, s.start_seconds);
      if (ov <= 0) continue;
      if (!best || ov > best.ov || (ov === best.ov && l.t0 < best.t0)) best = { ...l, ov };
    }
    const base = best ? best.h2.replace(/（续[^）]*）/g, '').trim() : '';
    if (!base || base.length < 2) { noLabel++; continue; }
    await client.query(`UPDATE kb_segment_new SET title=$1, h2_full=$2 WHERE segment_id=$3`,
      [base, best.h2.slice(0, 500), s.segment_id]);
    replaced++;
  }
  console.log(`[标题增强${courseFilter ? ' ' + courseFilter : ''}] 替换 ${replaced} | 保留 ${kept} | 无标签 ${noLabel}`);
  await client.end();
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
