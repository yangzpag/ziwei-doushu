#!/usr/bin/env tsx
/**
 * 导出样例卡片为人工可读 Markdown（含原文依据与 B 站链接）。
 *
 *   tsx scripts/vk/dump-cards.ts --run-id bencao-ep12 --limit 12 \
 *     --out data/vk/samples/sample-cards-bencao-ep12.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../../lib/vk/runner';
import { bilibiliUrl, formatHms } from '../../lib/vk/timeline';
import type { Card, CleanedEvidence, VideoMeta } from '../../lib/vk/types';

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
const runId = args['run-id'] ?? 'bencao-ep12';
const limit = Number(args.limit ?? 12);
const out = args.out ?? `data/vk/samples/sample-cards-${runId}.md`;
const runDir = path.join(process.cwd(), 'data/vk/runs', runId, 'videos');

const files = fs.readdirSync(runDir).filter((f) => f.endsWith('.json'));
const lines: string[] = [];
let count = 0;

for (const f of files) {
  const art = readJson<{
    video: VideoMeta;
    cleaned: CleanedEvidence[];
    cards: Card[];
  }>(path.join(runDir, f));
  const byId = new Map(art.cleaned.map((e) => [e.id, e]));
  for (const c of art.cards) {
    if (count >= limit) break;
    count += 1;
    const url = bilibiliUrl({ bvid: c.bvid, part: c.part, cid: c.cid, tMs: c.tStartMs });
    lines.push(`## ${count}. ${c.title}`);
    lines.push('');
    lines.push(`- 卡片 ID：\`${c.id}\`（segment \`${c.segmentId}\`，version ${c.version}）`);
    lines.push(`- 课程：${c.courseId} ｜ 章节：${c.chapter}${c.typeFields?.chapterFull ? `（${c.typeFields.chapterFull}）` : ''}`);
    lines.push(`- 质量：**${c.quality}** ｜ 完整度：**${c.completeness}** ｜ 生成方式：${c.genMode}`);
    lines.push(`- 视频时间点：${formatHms(c.tStartMs)}${c.tEndMs === null ? '（摘录无结束时间）' : `–${formatHms(c.tEndMs)}`}`);
    lines.push(`- B 站出处：${url || '（缺 BV 号）'}`);
    lines.push(`- 依据字幕：${c.evIds.length} 条（${c.evIds[0]} … ${c.evIds[c.evIds.length - 1]}）`);
    lines.push(`- 关键词：${c.keywords.join('、') || '（无）'}`);
    if (Array.isArray(c.typeFields?.herbs)) lines.push(`- 类型字段·药材：${(c.typeFields.herbs as string[]).join('、')}`);
    lines.push(`- 观点属性：${c.typeFields?.viewpoint ?? '—'}（课程内容为讲者观点，非已证实结论）`);
    lines.push('');
    lines.push('**摘要**');
    lines.push('');
    lines.push(`> ${c.summary}`);
    lines.push('');
    lines.push('**整理文本**');
    lines.push('');
    lines.push(c.body);
    lines.push('');
    lines.push('**原文依据（逐条可回溯）**');
    lines.push('');
    for (const p of c.points) {
      for (const id of p.evIds) {
        const ev = byId.get(id);
        lines.push(`- \`${id}\`（${formatHms(ev?.tStartMs ?? 0)}）：${ev?.rawText ?? '（缺失）'}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(
  out,
  `# 样例卡片（人工复核用）· run ${runId}\n\n> 由 scripts/vk/dump-cards.ts 生成；每条字幕可点击 B 站链接回放核对。\n\n${lines.join('\n')}`
);
console.log(`[dump] ${count} 张卡片 → ${out}`);
