#!/usr/bin/env tsx
/**
 * 知识卡片查询 CLI（PG 索引）。
 *
 *   tsx scripts/vk/query.ts "湿疹有哪些草药" --course 03-bencao
 *   tsx scripts/vk/query.ts --card 03-bencao-ep12-s003
 *   tsx scripts/vk/query.ts --list --course 03-bencao --limit 10
 */
import { searchCards, getCard, listCards } from '../../lib/vk/search';
import { formatHms } from '../../lib/vk/timeline';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._q = a;
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }

  if (args.card) {
    const hit = await getCard(String(args.card), databaseUrl);
    if (!hit) {
      console.error('卡片不存在');
      process.exit(1);
    }
    printHit(hit, 0);
    return;
  }

  if (args.list) {
    const hits = await listCards({
      databaseUrl,
      courseId: args.course ? String(args.course) : undefined,
      quality: args.quality ? String(args.quality) : undefined,
      limit: args.limit ? Number(args.limit) : 20,
    });
    console.log(`共 ${hits.length} 张卡片：`);
    hits.forEach((h, i) => printHit(h, i));
    return;
  }

  const q = String(args._q ?? '');
  if (!q) {
    console.error('用法: query.ts "问题" [--course id] [--limit n] | --card id | --list');
    process.exit(1);
  }
  const { mode, hits } = await searchCards(q, {
    databaseUrl,
    courseId: args.course ? String(args.course) : undefined,
    limit: args.limit ? Number(args.limit) : 5,
  });
  console.log(`模式: ${mode}  命中: ${hits.length}\n`);
  hits.forEach((h, i) => printHit(h, i));
}

function printHit(hit: import('../../lib/vk/search').CardHit, i: number) {
  const c = hit.card;
  console.log(`── [${i + 1}] ${c.title}  (${c.id})`);
  console.log(`    课程: ${c.courseId} | 章节: ${c.chapter} | ${formatHms(c.tStartMs)}–${c.tEndMs === null ? '?' : formatHms(c.tEndMs)}`);
  console.log(`    质量: ${c.quality} | 完整度: ${c.completeness} | 生成: ${c.genMode}${c.model ? ` (${c.model})` : ''}`);
  console.log(`    摘要: ${c.summary}`);
  console.log(`    关键词: ${c.keywords.join(', ')}`);
  console.log(`    出处: ${hit.url || '(缺 BV 号)'}`);
  console.log(`    依据字幕: ${c.evIds.length} 条 (${c.evIds[0]} … ${c.evIds[c.evIds.length - 1]})`);
  console.log('');
}

main().catch((e) => {
  console.error('[query] 失败:', e);
  process.exit(1);
});
