#!/usr/bin/env tsx
/**
 * 从摘录语料生成领域术语词表（数据驱动，不写死药材结构）。
 *
 *   tsx scripts/vk/build-glossary.ts --source data/corpus/entries.jsonl \
 *     --out data/vk/glossaries/shennong-bencao-herbs.txt
 *
 * 词表来源 = 语料 h2 标题的主名（「恒山 / 蜀漆 / 常山（…）」→ 三个术语），
 * 频率过低的术语剔除。可手工在文件里给术语加 ~ 后缀标记为不确定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractExcerptTerms } from '../../lib/vk/adapters/excerpt-jsonl';

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

const args = parseArgs(process.argv.slice(2));
const source = args.source ?? 'data/corpus/entries.jsonl';
const out = args.out ?? 'data/vk/glossaries/shennong-bencao-herbs.txt';
const minCount = Number(args['min-count'] ?? 2);
const book = args.book; // 如 03-bencao：只从该部提取术语

const content = fs.readFileSync(source, 'utf8');
const filtered = book
  ? content
      .split('\n')
      .filter((line) => {
        try {
          return (JSON.parse(line) as { book?: string }).book === book;
        } catch {
          return false;
        }
      })
      .join('\n')
  : content;
const terms = extractExcerptTerms(filtered).filter((t) => t.count >= minCount);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const lines = [
  '# 术语词表（由 scripts/vk/build-glossary.ts 从语料 h2 生成，可手工维护）',
  '# 行尾加 ~ 表示不确定术语：命中时只打待复核标记，不自动改写',
  ...terms.map((t) => t.term),
];
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`[glossary] ${terms.length} 个术语 → ${out}`);
