#!/usr/bin/env tsx
/**
 * 20 问评测：对索引后的卡片跑混合检索，报告前三条是否包含目标段落。
 *
 *   DATABASE_URL=… tsx scripts/vk/eval-questions.ts \
 *     --questions data/vk/samples/eval-questions-bencao-ep12.json --limit 3
 *
 * 判定规则（机械、可复现）：
 * - expectHerb：前三条中任一卡片的 标题/关键词/herbs字段/正文 命中该药材 → 命中；
 * - matchAny：前三条中任一卡片命中任一词 → 命中；
 * - expectNone：不做自动判定，记录前三条供人工复核（检索可能返回低分结果）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { searchCards, type CardHit } from '../../lib/vk/search';

interface Question {
  q: string;
  expectHerb?: string;
  matchAny?: string[];
  expectNone?: boolean;
  type: string;
  note?: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

function cardHaystack(hit: CardHit): string {
  const c = hit.card;
  const herbs = Array.isArray(c.typeFields?.herbs) ? (c.typeFields.herbs as string[]).join(' ') : '';
  const chapterFull = typeof c.typeFields?.chapterFull === 'string' ? c.typeFields.chapterFull : '';
  // chapter/chapterFull 是卡片的一部分且前端可见（如「大黄（下品；本集无口称味次）」），计入判定
  return `${c.chapter} ${chapterFull} ${c.title} ${c.summary} ${c.keywords.join(' ')} ${herbs} ${c.body}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const qFile = args.questions ?? 'data/vk/samples/eval-questions-bencao-ep12.json';
  const limit = Number(args.limit ?? 3);
  const spec = JSON.parse(fs.readFileSync(qFile, 'utf8')) as {
    course?: string;
    questions: Question[];
  };
  const courseId = args.course ?? spec.course;

  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  log(`# 检索评测报告（${path.basename(qFile)}）\n`);
  log(`- 检索范围：${courseId ?? '全部课程'}，前 ${limit} 条`);
  log(`- 生成时间：${new Date().toISOString()}\n`);
  log('| # | 问题 | 类型 | 前三条命中 | 判定 | 前三条卡片 |');
  log('|---|---|---|---|---|---|');

  let pass = 0;
  let fail = 0;
  let manual = 0;
  const details: string[] = [];

  for (const [i, item] of spec.questions.entries()) {
    const { hits } = await searchCards(item.q, { databaseUrl, courseId, limit });
    const top = hits.slice(0, limit);
    const topTitles = top.map((h) => h.card.title).join(' / ') || '（无命中）';

    let verdict: string;
    if (item.expectNone) {
      verdict = '人工复核';
      manual += 1;
    } else {
      const predicate = item.expectHerb
        ? (h: CardHit) => cardHaystack(h).includes(item.expectHerb!)
        : (h: CardHit) => (item.matchAny ?? []).some((t) => cardHaystack(h).includes(t));
      const hitIndex = top.findIndex(predicate);
      if (hitIndex >= 0) {
        verdict = `✓ 命中（第 ${hitIndex + 1} 条）`;
        pass += 1;
      } else {
        verdict = '✗ 未命中';
        fail += 1;
      }
    }
    log(`| ${i + 1} | ${item.q} | ${item.type} | ${top.length} | ${verdict} | ${topTitles} |`);

    details.push(`\n## ${i + 1}. ${item.q}`);
    details.push(`- 类型：${item.type}${item.note ? `（${item.note}）` : ''}`);
    details.push(`- 判定：${verdict}`);
    if (top.length) {
      details.push('- 前三条：');
      top.forEach((h, j) => {
        details.push(
          `  ${j + 1}. [${h.card.id}] ${h.card.title}（${h.card.quality}/${h.card.completeness}，score=${h.score.toFixed(3)}）`
        );
      });
    } else {
      details.push('- 前三条：（无命中）');
    }
  }

  const checkable = pass + fail;
  log(`\n## 汇总\n`);
  log(`- 可自动判定 ${checkable} 题：命中 ${pass}，未命中 ${fail}${checkable ? `（命中率 ${((pass / checkable) * 100).toFixed(0)}%）` : ''}`);
  log(`- 人工复核 ${manual} 题（无答案类：记录前三条供人工判断）`);
  log('\n<details><summary>逐题明细</summary>\n');
  log(details.join('\n'));
  log('\n</details>');

  const outPath = path.join(process.cwd(), 'data/vk/runs/eval-report.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
  console.log(`\n[eval] 报告已写入 ${outPath}`);
}

main().catch((e) => {
  console.error('[eval] 失败:', e);
  process.exit(1);
});
