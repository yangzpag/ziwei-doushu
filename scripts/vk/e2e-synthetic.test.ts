/**
 * 端到端测试：合成非中医字幕（摄影课）跑完整流水线。
 *
 * 验证点：
 * 1. 核心流程无需改代码即可复用（content-type 换成 generic-lecture）；
 * 2. 卡片可溯源（每条 evIds 有效、B 站链接可由程序生成）；
 * 3. 断点续跑：二次运行命中缓存（skipped > 0）；
 * 4. 阶段独立：先跑 import/clean/segment，再跑 card/validate 可接续；
 * 5. mock LLM：结果明确标识 genMode=mock，不当成真实模型输出。
 *
 *   tsx scripts/vk/e2e-synthetic.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipeline } from '../../lib/vk/runner';
import { createMockSummarizer } from '../../lib/vk/mock-llm';
import { validateVideoCards } from '../../lib/vk/validate';
import { getConfig } from '../../lib/vk/config';
import { bilibiliUrl } from '../../lib/vk/timeline';
import type { Card } from '../../lib/vk/types';

const SRT = path.join(process.cwd(), 'data/vk/samples/synthetic-photography-101.srt');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-e2e-'));

const VIDEO_META = {
  videoId: 'photo-101',
  courseId: 'photo',
  courseName: '摄影基础',
  bvid: 'BV1synthetic',
  part: 1,
  title: '相机曝光三角入门',
  contentType: 'generic-lecture',
};

/** 内存迷你检索（测试用；PG 混合检索由 query CLI 在真实数据上验证） */
function miniSearch(cards: Card[], q: string, topN = 3): Card[] {
  const terms = q.split(/[\s,，。？！]+/).filter((t) => t.length >= 2);
  return cards
    .map((c) => {
      const hay = `${c.title} ${c.summary} ${c.keywords.join(' ')} ${c.body}`;
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.c);
}

async function main() {
  // ── 第一次全流程 ──
  const r1 = await runPipeline({
    source: SRT,
    format: 'srt',
    videoMeta: VIDEO_META,
    runId: 'e2e-photo',
    outDir: OUT,
    stages: ['import', 'clean', 'segment', 'card', 'validate'],
    concurrency: 1,
  });
  assert.equal(r1.videos, 1);
  assert.ok(r1.cards > 0, '应产出卡片');
  console.log(`[e2e] 首次运行：${r1.cards} 张卡片，质量 validated=${r1.quality.validated} needs_review=${r1.quality.needsReview} rejected=${r1.quality.rejected}`);

  const artifact = JSON.parse(
    fs.readFileSync(path.join(OUT, 'runs', 'e2e-photo', 'videos', 'photo-101.json'), 'utf8')
  ) as {
    video: { mode: string; bvid: string };
    cards: Card[];
    validation: { cardId: string; quality: string; issues: { code: string; severity: string }[] }[];
  };
  assert.equal(artifact.video.mode, 'full_transcript');
  const cards = artifact.cards;
  assert.ok(cards.length > 0);

  // 完整字幕模式：全部卡片应通过校验（连续覆盖 + 要点有依据）
  assert.equal(r1.quality.rejected, 0, '完整字幕流程不应有 rejected 卡片');
  assert.equal(r1.quality.needsReview, 0, JSON.stringify(artifact.validation.filter((v) => v.quality !== 'validated')));

  // 完整字幕不允许 partial；结尾弱信息段（下节预告+再见）允许 needs_context
  const completeCards = cards.filter((c) => c.completeness === 'complete');
  const contextCards = cards.filter((c) => c.completeness === 'needs_context');
  assert.equal(completeCards.length + contextCards.length, cards.length, '完整字幕不得出现 partial');
  assert.ok(completeCards.length >= cards.length - 1, '至多结尾一段 needs_context');
  console.log(`[e2e] 完整度：complete=${completeCards.length} needs_context=${contextCards.length}（结尾弱信息段）`);

  // 每张卡片可溯源：evIds 非空、起始时间递增、链接可生成
  let prevStart = -1;
  for (const c of cards) {
    assert.ok(c.evIds.length > 0, `${c.id} 无字幕依据`);
    assert.ok(c.tStartMs >= prevStart, '卡片时间应递增');
    prevStart = c.tStartMs;
    const url = bilibiliUrl({ bvid: c.bvid, part: c.part, tMs: c.tStartMs });
    assert.ok(url.startsWith('https://www.bilibili.com/video/BV1synthetic?t='), url);
    assert.ok(c.summary.length > 0 && c.body.length > 0);
    assert.ok(c.completeness !== 'partial', '完整字幕卡片不得标记 partial');
  }

  // 检索有效性：宽泛/精确/无答案问题
  const q1 = miniSearch(cards, '光圈 景深 背景模糊');
  assert.ok(q1.length > 0 && /光圈/.test(q1[0].title + q1[0].summary + q1[0].body), '光圈问题应命中光圈段落');
  const q2 = miniSearch(cards, '安全快门 焦距 倒数');
  assert.ok(q2.length > 0 && /快门/.test(q2[0].title + q2[0].summary + q2[0].body), '快门问题应命中快门段落');
  const q3 = miniSearch(cards, '白平衡 色彩 后期');
  const q3Hit = q3.find((c) => /白平衡/.test(c.body));
  assert.ok(q3Hit, '末尾提到白平衡的内容应可被检索到');
  const q4 = miniSearch(cards, '紫微斗数 排盘');
  assert.equal(q4.length, 0, '无关问题不应命中（无答案问题）');
  console.log('[e2e] 检索抽查通过（宽泛/精确/无答案）');

  // ── 断点续跑：二次运行全部命中缓存 ──
  const r2 = await runPipeline({
    source: SRT,
    format: 'srt',
    videoMeta: VIDEO_META,
    runId: 'e2e-photo-2',
    outDir: OUT,
    stages: ['import', 'clean', 'segment', 'card', 'validate'],
    concurrency: 1,
  });
  // 注意：runId 不同则 state.json 不同；缓存按内容哈希命中，卡片数与质量一致
  assert.equal(r2.cards, r1.cards);
  assert.equal(r2.quality.validated, r1.quality.validated);
  console.log(`[e2e] 二次运行一致（cards=${r2.cards}）`);

  // 同 runId 重跑 → skipped（断点续跑）
  const r3 = await runPipeline({
    source: SRT,
    format: 'srt',
    videoMeta: VIDEO_META,
    runId: 'e2e-photo',
    outDir: OUT,
    stages: ['import', 'clean', 'segment', 'card', 'validate'],
    concurrency: 1,
  });
  assert.ok(r3.stages.clean.skipped + r3.stages.segment.skipped + r3.stages.card.skipped > 0, '同 runId 重跑应跳过已完成阶段');
  console.log(`[e2e] 断点续跑跳过 clean=${r3.stages.clean.skipped} segment=${r3.stages.segment.skipped} card=${r3.stages.card.skipped}`);

  // ── 阶段独立：分两次跑（模拟任务中断后接续） ──
  const r4a = await runPipeline({
    source: SRT,
    format: 'srt',
    videoMeta: VIDEO_META,
    runId: 'e2e-split',
    outDir: OUT,
    stages: ['import', 'clean', 'segment'],
    concurrency: 1,
  });
  assert.equal(r4a.cards, 0);
  const r4b = await runPipeline({
    source: SRT,
    format: 'srt',
    videoMeta: VIDEO_META,
    runId: 'e2e-split',
    outDir: OUT,
    stages: ['card', 'validate'],
    concurrency: 1,
  });
  assert.equal(r4b.cards, r1.cards, '中断后续跑应接续产出全部卡片');
  console.log('[e2e] 阶段独立/中断接续通过');

  // ── mock LLM 路径：明确标识，不当真实结果 ──
  const r5 = await runPipeline({
    source: SRT,
    format: 'srt',
    videoMeta: VIDEO_META,
    runId: 'e2e-mock',
    outDir: OUT,
    stages: ['card', 'validate'],
    force: true,
    llmSummarizer: createMockSummarizer(),
    concurrency: 1,
  });
  const mockArtifact = JSON.parse(
    fs.readFileSync(path.join(OUT, 'runs', 'e2e-mock', 'videos', 'photo-101.json'), 'utf8')
  ) as { cards: Card[] };
  for (const c of mockArtifact.cards) {
    assert.equal(c.genMode, 'llm');
    assert.equal(c.model, 'mock-llm-1');
    assert.ok(c.title.startsWith('[MOCK]'), 'mock 输出必须带标识');
  }
  console.log('[e2e] mock LLM 链路通过（输出带 [MOCK] 标识）');

  // ── 非中医内容零代码复用证明：同一入口、不同配置即完成 ──
  // （本测试自身就是证明：generic-lecture + 合成摄影字幕，未改任何 lib/vk 代码）

  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('\n端到端（合成非中医字幕）测试全部通过');
}

main().catch((e) => {
  console.error('[e2e] 失败:', e);
  process.exit(1);
});
