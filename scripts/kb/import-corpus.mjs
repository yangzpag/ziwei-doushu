/**
 * 中医知识库语料导入（一次性，可重复执行 = truncate 后重建）
 *
 *   DATABASE_URL=postgres://… node scripts/kb/import-corpus.mjs
 *
 * 流程：读 data/corpus/entries.jsonl → 聚合部统计 → 调 embed-server 批量向量化 →
 *      unnest 批量写入 corpus_entry（带 HNSW 索引）。
 * 依赖：embed-server 已在 EMBED_URL（默认 127.0.0.1:3001）运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:3001';
const BATCH = Number(process.env.KB_BATCH || 64);
const ENTRIES = path.join(process.cwd(), 'data/corpus/entries.jsonl');

if (!DATABASE_URL) {
  console.error('缺少 DATABASE_URL 环境变量');
  process.exit(1);
}

/** 部元数据（名称/排序/简介）——与 nihai-renji-corpus README 对齐 */
const BOOK_META = {
  '01-shanghan': { sort: 1, intro: '宋本 398 条为锚，太阳/阳明/少阳/太阴/少阴/厥阴六经辨证。' },
  '02-jinkui': { sort: 2, intro: '脏腑经络至妇人杂病二十二篇，含倪师临床病例。' },
  '03-bencao': { sort: 3, intro: '序例/玉石/草部上中下品/增补，按药名立目。' },
  '04-neijing': { sort: 4, intro: '素问 1–81 篇（含遗篇），按篇立目。' },
  '05-zhongjing': { sort: 5, intro: '倪师对伤寒金匮的复讲与临证心法。' },
  '06-zhenjiu': { sort: 6, intro: '十二正经/奇经八脉/十五络/针法/治症/子午流注/临床实操。' },
};

async function embed(texts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${EMBED_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      });
      if (!res.ok) throw new Error(`embed ${res.status}`);
      const { vectors } = await res.json();
      return vectors;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1. 读取 + 聚合
  console.log('[import] 读取语料…');
  const lines = fs.readFileSync(ENTRIES, 'utf8').split('\n').filter(Boolean);
  const books = new Map();
  const rows = [];
  for (const line of lines) {
    const e = JSON.parse(line);
    if (!e.book || !e.quote) continue;
    if (!books.has(e.book)) {
      books.set(e.book, { id: e.book, name: e.part_name, short: (e.part_name || '').slice(0, 1), epsSet: new Set(), h2Set: new Set() });
    }
    const b = books.get(e.book);
    b.epsSet.add(e.ep);
    b.h2Set.add(e.h2);
    rows.push(e);
  }
  console.log(`[import] ${rows.length} 条判语，${books.size} 部`);

  // 2. 写入 corpus_book
  await client.query('TRUNCATE corpus_entry');
  for (const b of books.values()) {
    const meta = BOOK_META[b.id] || { sort: 99, intro: '' };
    await client.query(
      `INSERT INTO corpus_book (id, name, short, entries, eps, eps_list, h2_count, intro, sort_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, short=EXCLUDED.short, entries=EXCLUDED.entries,
         eps=EXCLUDED.eps, eps_list=EXCLUDED.eps_list, h2_count=EXCLUDED.h2_count, intro=EXCLUDED.intro, sort_no=EXCLUDED.sort_no`,
      [
        b.id, b.name, b.short, rows.filter((r) => r.book === b.id).length, b.epsSet.size,
        JSON.stringify([...b.epsSet].sort((x, y) => x - y)), b.h2Set.size, meta.intro, meta.sort,
      ]
    );
  }
  console.log('[import] corpus_book 已写入');

  // 3. 预热 embed-server（模型懒加载，首批会触发下载）
  console.log('[import] 预热 embedding 服务（首次约 1 分钟）…');
  await embed(['预热']);

  // 4. 批量向量化 + 写入
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vectors = await embed(batch.map((e) => `${e.h2 || ''} ${e.h3 || ''} ${e.quote || ''}`));
    const n = batch.length;
    await client.query(
      `INSERT INTO corpus_entry (book_id, h2, h3, quote, bvid, ep, t_hms, search_text, embedding)
       SELECT * FROM unnest(
         $1::varchar[], $2::varchar[], $3::varchar[], $4::text[], $5::varchar[],
         $6::int[], $7::varchar[], $8::text[], $9::text[]::vector[]
       )`,
      [
        batch.map((e) => e.book),
        batch.map((e) => e.h2 || ''),
        batch.map((e) => e.h3 || ''),
        batch.map((e) => e.quote || ''),
        batch.map((e) => e.bvid || ''),
        batch.map((e) => e.ep || 0),
        batch.map((e) => e.t_hms || ''),
        batch.map((e) => `${e.h2 || ''} ${e.h3 || ''} ${e.quote || ''}`),
        vectors.map((v) => `[${v.join(',')}]`),
      ]
    );
    if ((i / BATCH) % 20 === 0) {
      const pct = (((i + n) / rows.length) * 100).toFixed(1);
      const eta = ((Date.now() - t0) / (i + n)) * (rows.length - i - n) / 1000;
      console.log(`[import] ${i + n}/${rows.length} (${pct}%) 预计剩余 ${eta.toFixed(0)}s`);
    }
  }

  const { rows: [cnt] } = await client.query('SELECT count(*)::int AS n FROM corpus_entry');
  console.log(`[import] 完成：corpus_entry 共 ${cnt} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await client.end();
}

main().catch((e) => {
  console.error('[import] 失败:', e.message);
  process.exit(1);
});
