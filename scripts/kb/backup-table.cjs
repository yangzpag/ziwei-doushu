#!/usr/bin/env node
/** 单表备份（ctid 分页防内存峰值）：node backup-table.cjs <table> → backups/<date>/<table>.jsonl.gz */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pg = require('pg');

const table = process.argv[2];
if (!table || !/^[a-z_]+$/.test(table)) { console.error('用法: node backup-table.cjs <table>'); process.exit(1); }

const date = new Date().toISOString().slice(0, 10);
const dir = path.resolve(process.cwd(), `backups/${date}`);
fs.mkdirSync(dir, { recursive: true });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
client.connect().then(async () => {
  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND table_schema='public' AND column_name<>'embedding' ORDER BY ordinal_position`, [table]
  )).rows.map((r) => r.column_name);
  const colList = cols.join(',');
  const count = Number((await client.query(`SELECT count(*) c FROM ${table}`)).rows[0].c);

  const parts = [];
  const CHUNK = 300;
  for (let off = 0; off < count; off += CHUNK) {
    const { rows } = await client.query(
      `SELECT ${colList} FROM ${table} ORDER BY ctid LIMIT ${CHUNK} OFFSET ${off}`);
    parts.push(...rows.map((r) => JSON.stringify(r)));
  }
  const out = path.join(dir, `${table}.jsonl.gz`);
  fs.writeFileSync(out, zlib.gzipSync(parts.join('\n')));
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`  ${table.padEnd(14)} ${String(count).padStart(6)} 行  ${kb}KB`);
  // 追加 MANIFEST
  fs.appendFileSync(path.join(dir, 'MANIFEST.txt'), `${table}\t${count} 行\t${kb}KB\n`);
  await client.end();
  process.exit(0);
}).catch((e) => { console.error(`  ${table} 失败:`, e.message); process.exit(1); });
