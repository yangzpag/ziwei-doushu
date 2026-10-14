#!/usr/bin/env tsx
/**
 * Agent 撰写卡片工作台。
 *
 * 数据预处理由会话内 AI 助手直接分析（不调用外部 API）：
 *
 *   # 1) 导出撰写工作单（段落 + 证据字幕，含 ID 与时间）
 *   tsx scripts/vk/author-cards.ts --dump --run bencao-ep12 --video 03-bencao-ep12 \
 *     --out data/vk/authors/bencao-ep12.worksheet.json
 *
 *   # 2. AI 阅读工作单后撰写卡片（title/summary/points/keywords/typeFields），
 *      保存为 --cards 指定的 JSON（schema 见 docs/video-kb-pipeline.md）
 *
 *   # 3) 合入运行产物：程序补整理文本/时间/B站链接，重跑校验后覆写
 *   tsx scripts/vk/author-cards.ts --load --run bencao-ep12 --video 03-bencao-ep12 \
 *     --cards data/vk/authors/bencao-ep12.cards.json
 *
 * agent 卡片：genMode='agent'，校验走「二元组重叠 + 需人工抽查告警」，
 * 与 extractive 卡片同一 schema、同一校验管线，来源可区分。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../../lib/vk/runner';
import { buildCard } from '../../lib/vk/card';
import { buildBodyFromCues } from '../../lib/vk/summarize';
import { validateVideoCards } from '../../lib/vk/validate';
import { resolveConfig, CONFIG_VERSION } from '../../lib/vk/config';
import { contentHash, stageKey } from '../../lib/vk/cache';
import type { Card, CardPoint, CleanedEvidence, Segment, VideoMeta } from '../../lib/vk/types';

interface AuthoredCard {
  segmentId: string;
  title: string;
  summary: string;
  points: { text: string; evIds: string[] }[];
  keywords: string[];
  typeFields?: Record<string, unknown>;
}

interface AuthoredFile {
  videoId: string;
  author: string;
  authoredAt: string;
  cards: AuthoredCard[];
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = typeof args.run === 'string' ? args.run : '';
  const videoId = typeof args.video === 'string' ? args.video : '';
  if (!run || !videoId) {
    console.error('用法: author-cards.ts --dump|--load --run <runId> --video <videoId> [--out file] [--cards file]');
    process.exit(1);
  }
  const artifactPath = path.join(process.cwd(), 'data/vk/runs', run, 'videos', `${videoId}.json`);
  if (!fs.existsSync(artifactPath)) {
    console.error(`运行产物不存在: ${artifactPath}（先跑 scripts/vk/run.ts）`);
    process.exit(1);
  }
  const artifact = readJson<{
    video: VideoMeta;
    cleaned: CleanedEvidence[];
    segments: Segment[];
    cards: Card[];
    validation: unknown[];
  }>(artifactPath);

  if (args.dump) {
    const evById = new Map(artifact.cleaned.map((e) => [e.id, e]));
    const worksheet = {
      videoId,
      video: {
        courseName: artifact.video.courseName,
        bvid: artifact.video.bvid,
        mode: artifact.video.mode,
        contentType: artifact.video.contentType,
      },
      note: 'AI 撰写约束：只能依据 cues 里的内容；每个要点挂支撑它的字幕 ID；不得补写缺失讲解；信息不足在 summary 里如实说明。',
      segments: artifact.segments.map((s) => ({
        segmentId: s.id,
        chapter: s.title,
        contentType: s.contentType,
        completeness: s.completeness,
        tStartMs: s.tStartMs,
        tEndMs: s.tEndMs,
        internalGapsMs: s.internalGapsMs,
        cues: s.evIds.map((id) => {
          const e = evById.get(id)!;
          return { id, tStartMs: e.tStartMs, text: e.cleanText };
        }),
      })),
    };
    const out = typeof args.out === 'string' ? args.out : path.join('data/vk/authors', `${videoId}.worksheet.json`);
    writeJson(path.resolve(out), worksheet);
    console.log(`[author] 工作单已导出: ${out}（${worksheet.segments.length} 段 / ${artifact.cleaned.length} 条证据）`);
    return;
  }

  if (args.load) {
    const cardsFile = typeof args.cards === 'string' ? args.cards : '';
    if (!cardsFile) {
      console.error('--load 需要 --cards <file>');
      process.exit(1);
    }
    const authored = readJson<AuthoredFile>(path.resolve(cardsFile));
    if (authored.videoId !== videoId) {
      console.error(`卡片文件 videoId=${authored.videoId} 与 --video ${videoId} 不符`);
      process.exit(1);
    }
    const segById = new Map(artifact.segments.map((s) => [s.id, s]));
    const evById = new Map(artifact.cleaned.map((e) => [e.id, e]));
    const merged: Card[] = [];
    let replaced = 0;
    for (const a of authored.cards) {
      const seg = segById.get(a.segmentId);
      if (!seg) {
        console.error(`[author] 段落不存在: ${a.segmentId}（已跳过）`);
        continue;
      }
      const cues = seg.evIds
        .map((id) => evById.get(id))
        .filter((e): e is CleanedEvidence => Boolean(e && e.cleanText));
      const config = resolveConfig(seg.contentType);
      const { text: body } = buildBodyFromCues(cues, config);
      const points: CardPoint[] = a.points.map((p) => ({ text: p.text, evIds: p.evIds }));
      const card = buildCard(
        seg,
        {
          title: a.title,
          summary: a.summary,
          points,
          body,
          keywords: a.keywords,
          typeFields: { viewpoint: 'speaker', ...(a.typeFields ?? {}) },
          needsContext: false,
          notes: [`agent-authored by ${authored.author} @ ${authored.authoredAt}`],
        },
        artifact.video,
        { genMode: 'agent', model: `${authored.author}@${authored.authoredAt}` }
      );
      merged.push(card);
      replaced += 1;
    }
    // 合入：被撰写的段落替换 extractive 卡片，其余保留
    const authoredIds = new Set(merged.map((c) => c.segmentId));
    const finalCards = [
      ...artifact.cards.filter((c) => !authoredIds.has(c.segmentId)),
      ...merged,
    ].sort((a, b) => a.id.localeCompare(b.id));

    const validation = validateVideoCards(
      finalCards,
      artifact.video,
      evById,
      (id) => resolveConfig(id)
    );
    for (const r of validation) {
      const card = finalCards.find((c) => c.id === r.cardId);
      if (card) card.quality = r.quality;
    }
    writeJson(artifactPath, { ...artifact, cards: finalCards, validation });

    // 同步写回卡片缓存：否则重跑 run.ts 命中缓存时会把 agent 卡片覆盖成抽取式
    const videoConfig = resolveConfig(artifact.video.contentType);
    const cardKey = stageKey('card', CONFIG_VERSION, [
      { id: videoId, hash: contentHash({ segments: artifact.segments, cleaned: artifact.cleaned }) },
      { id: 'config', hash: contentHash(videoConfig) },
      { id: 'llm', hash: contentHash('extractive') },
    ]);
    const cardCachePath = path.join(process.cwd(), 'data/vk/cache/card', `${cardKey}.json`);
    writeJson(cardCachePath, finalCards);
    const q = finalCards.reduce<Record<string, number>>((acc, c) => {
      acc[c.quality] = (acc[c.quality] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[author] 已合入 ${replaced} 张 agent 卡片（总 ${finalCards.length} 张），质量: ${JSON.stringify(q)}`);
    const warned = validation.filter((v) => v.issues.some((i) => i.code === 'agent-authored'));
    console.log(`[author] 其中 ${warned.length} 张带「需人工抽查」告警（转述支持度自动校验不可靠，请对照原文审查）`);
  }
}

main().catch((e) => {
  console.error('[author] 失败:', e);
  process.exit(1);
});
