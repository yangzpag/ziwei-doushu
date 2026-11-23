#!/usr/bin/env node
/**
 * 原子切换：kb_segment_new → kb_segment，旧表改名保留为 kb_segment_old。
 *   node swap-segments.cjs          # 只切换（旧表保留为 _old）
 *   node swap-segments.cjs --drop   # 切换并删除全部旧表（corpus/vk/_old）
 * 备份在 backups/2026-10-25/，删除前务必确认备份存在。
 */
const fs = require('fs');
const path = require('path');
const pg = require('pg');

const drop = process.argv.includes('--drop');
const backupDir = path.resolve(process.cwd(), 'backups/2026-10-25');
const needBackup = ['corpus_book', 'corpus_entry', 'kb_segment', 'vk_video', 'vk_chapter', 'vk_chunk', 'vk_segment', 'vk_card', 'vk_evidence', 'vk_run', 'vk_review'];

if (drop) {
  const missing = needBackup.filter((t) => !fs.existsSync(path.join(backupDir, `${t}.jsonl.gz`)));
  if (missing.length) { console.error('备份缺失，拒绝删除:', missing.join(',')); process.exit(1); }
  console.log(`[swap] 备份齐全（${needBackup.length} 表，${backupDir}）`);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
client.connect().then(async () => {
  // 确认新表有数据
  const cnt = await client.query('SELECT count(*) c FROM kb_segment_new');
  const n = Number(cnt.rows[0].c);
  if (n < 2000) { console.error(`kb_segment_new 只有 ${n} 段（预期 ≥2000），中止`); process.exit(1); }
  console.log(`[swap] 新表 ${n} 段`);

  if (drop) {
    // 删除旧语料与 vk_*（备份已确认存在）
    await client.query('DROP TABLE IF EXISTS corpus_entry, corpus_book, kb_segment_old, vk_video, vk_chapter, vk_chunk, vk_segment, vk_card, vk_evidence, vk_run, vk_review CASCADE');
    console.log('[swap] 旧表已删除（corpus_entry/corpus_book/kb_segment_old/vk_*×7）');
  } else {
    await client.query('DROP TABLE IF EXISTS kb_segment_old');
  }

  // 原子切换
  await client.query('BEGIN');
  await client.query('ALTER TABLE kb_segment RENAME TO kb_segment_old');
  await client.query('ALTER TABLE kb_segment_new RENAME TO kb_segment');
  await client.query('COMMIT');
  console.log('[swap] kb_segment_new → kb_segment 完成');

  const after = await client.query('SELECT count(*) c, count(bvid) bv, count(DISTINCT course_id) courses FROM kb_segment');
  console.log(`[swap] 现役 kb_segment: ${after.rows[0].c} 段 / ${after.rows[0].bv} 段有 bvid / ${after.rows[0].courses} 部`);
  await client.end();
  process.exit(0);
}).catch((e) => { console.error('swap 失败:', e.message); process.exit(1); });
