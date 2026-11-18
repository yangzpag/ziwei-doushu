#!/usr/bin/env node
/**
 * 验证新段落检索质量：验收问题 → 向量 → kb_segment(_new) Top-K。
 * 用法: node verify-srt-segments.cjs [table]   （默认对比新旧两表）
 */
const fs = require('fs');
const pg = require('pg');

const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:3003';
const QUERIES = ['鼻炎怎么治疗', '湿疹怎么治疗', '条336讲什么', '蛇床子怎么用', '失眠怎么治疗', '乌梅丸是什么方子'];
const table = process.argv[2];
const tables = table ? [table] : ['kb_segment_new', 'kb_segment'];

async function embed(text) {
  const res = await fetch(`${EMBED_URL}/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: [text] }), signal: AbortSignal.timeout(60_000),
  });
  const { vectors } = await res.json();
  return vectors[0];
}

(async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  for (const q of QUERIES) {
    const vec = await embed(q);
    const vecStr = `[${vec.join(',')}]`;
    console.log(`\n########## Q: ${q} ##########`);
    for (const t of tables) {
      try {
        const { rows } = await client.query(
          `SELECT segment_id, course_id, title, start_seconds, end_seconds, bvid, text,
                  1 - (embedding <=> $1::vector) AS score
             FROM ${t} ORDER BY embedding <=> $1::vector LIMIT 3`, [vecStr]);
        console.log(`  ── ${t} ──`);
        rows.forEach((r, i) => {
          const mm = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
          console.log(`   [${i + 1}] ${Number(r.score).toFixed(3)} ${r.course_id} 「${r.title}」 ${mm(Number(r.start_seconds))}-${mm(Number(r.end_seconds))} ${r.bvid ? '🔗' : '(无bvid)'}`);
          console.log(`       ${r.text.slice(0, 80)}…`);
        });
      } catch (e) {
        console.log(`  ── ${t} ── 不可用: ${e.message.split('\n')[0]}`);
      }
    }
  }
  await client.end();
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
