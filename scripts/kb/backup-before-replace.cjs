#!/usr/bin/env node
/**
 * 删除前备份：把旧语料相关表导出为 JSONL.gz（每行一个 JSON 对象）。
 * embedding 列除外（向量可由文本+bge 模型确定性重算）。
 * 输出 backups/<date>/<table>.jsonl.gz + MANIFEST.txt
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pg = require('pg');

const TABLES = process.argv[2] ? [process.argv[2]] : [
  'corpus_book', 'corpus_entry', 'kb_segment',
  'vk_video', 'vk_chapter', 'vk_chunk', 'vk_segment', 'vk_card', 'vk_evidence', 'vk_run', 'vk_review',
];

const date = new Date().toISOString().slice(0, 10);
const dir = path.resolve(process.cwd(), `backups/${date}`);
fs.mkdirSync(dir, { recursive: true });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
client.connect().then(async () => {
  const manifest = [];
  for (const t of TABLES) {
    // SQL 侧排除 embedding（512 维向量拉进内存会被杀）；向量可由文本重算
    const cols = (await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name<>'embedding' ORDER BY ordinal_position`, [t]
    )).rows.map((r) => r.column_name);
    const { rows } = await client.query(`SELECT ${cols.join(',')} FROM ${t}`);
    const cleaned = rows;
    const out = path.join(dir, `${t}.jsonl.gz`);
    const body = cleaned.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(out, zlib.gzipSync(body));
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    manifest.push(`${t}\t${rows.length} 行\t${kb}KB`);
    console.log(`  ${t.padEnd(14)} ${String(rows.length).padStart(6)} 行  ${kb}KB`);
  }
  fs.writeFileSync(path.join(dir, 'MANIFEST.txt'), `备份时间: ${new Date().toISOString()}\n来源库: Neon ziwei（DATABASE_URL 指向）\n说明: embedding 列未导出，可由文本 + bge-small-zh-v1.5 重算\n\n` + manifest.join('\n') + '\n');
  console.log(`\n备份完成 → ${dir}`);
  await client.end();
}).catch((e) => { console.error('备份失败:', e.message); process.exit(1); });
