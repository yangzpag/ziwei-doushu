/**
 * 视频知识流水线单元测试（tsx + node:assert/strict，无网络/DB 依赖）。
 *
 *   tsx scripts/vk/pipeline.test.ts
 */
import assert from 'node:assert/strict';
import {
  parseTimestampToMs,
  formatHms,
  bilibiliUrl,
} from '../../lib/vk/timeline';
import { parseSrt } from '../../lib/vk/adapters/srt';
import { parseVtt } from '../../lib/vk/adapters/vtt';
import { parseSubtitleJson } from '../../lib/vk/adapters/subtitle-json';
import { parseExcerptJsonl, extractExcerptTerms } from '../../lib/vk/adapters/excerpt-jsonl';
import { detectFormat } from '../../lib/vk/adapters';
import { cleanEvidence } from '../../lib/vk/clean';
import { Glossary } from '../../lib/vk/glossary';
import { segmentVideo, displayTitle } from '../../lib/vk/segment';
import { summarizeSegment } from '../../lib/vk/summarize';
import { buildCard } from '../../lib/vk/card';
import { validateCard, containmentRatio } from '../../lib/vk/validate';
import { chunkCard } from '../../lib/vk/store';
import { contentHash, stageKey } from '../../lib/vk/cache';
import { getConfig, detectChapterType, CONFIG_VERSION } from '../../lib/vk/config';
import type { CleanedEvidence, Evidence, VideoMeta } from '../../lib/vk/types';

// ─────────────────────────  helpers  ─────────────────────────

let evSeq = 0;
function ev(
  videoId: string,
  tStartMs: number,
  tEndMs: number | null,
  rawText: string,
  meta?: Record<string, string | number>
): Evidence {
  evSeq += 1;
  return {
    id: `${videoId}#${evSeq}`,
    videoId,
    seq: evSeq,
    tStartMs,
    tEndMs,
    rawText,
    source: 'subtitle',
    meta,
  };
}

function excerptEv(
  videoId: string,
  seq: number,
  tStartMs: number,
  rawText: string,
  meta: Record<string, string | number>
): Evidence {
  return {
    id: `${videoId}#${seq}`,
    videoId,
    seq,
    tStartMs,
    tEndMs: null, // 摘录只有起始时间
    rawText,
    source: 'excerpt',
    meta,
  };
}

function clean(evidence: Evidence[], mode: 'full_transcript' | 'excerpt', glossary?: Glossary) {
  const config = getConfig(mode === 'excerpt' ? 'book-commentary' : 'generic-lecture');
  return cleanEvidence(evidence, { mode, ...config.clean, glossary });
}

// ─────────────────────────  timeline  ─────────────────────────

assert.equal(parseTimestampToMs('00:01:23'), 83_000);
assert.equal(parseTimestampToMs('01:02:03,456'), 3_723_456);
assert.equal(parseTimestampToMs('00:00:07.500'), 7_500);
assert.equal(parseTimestampToMs('83'), 83_000);
assert.equal(parseTimestampToMs(83.5), 83_500); // 小数按秒
assert.equal(parseTimestampToMs(83_000_000), 83_000_000); // ≥86400 按毫秒
assert.equal(parseTimestampToMs(4.2), 4_200);
assert.throws(() => parseTimestampToMs('abc'));
assert.equal(formatHms(83_000), '00:01:23');
assert.equal(formatHms(3_723_456), '01:02:03');
assert.equal(
  bilibiliUrl({ bvid: 'BV1Tr8czuEws', part: 1, tMs: 83_400 }),
  'https://www.bilibili.com/video/BV1Tr8czuEws?t=83'
);
assert.equal(
  bilibiliUrl({ bvid: 'BV1Tr8czuEws', part: 3, tMs: 0 }),
  'https://www.bilibili.com/video/BV1Tr8czuEws?t=0&p=3'
);
assert.equal(bilibiliUrl({ bvid: '', tMs: 0 }), '');
console.log('✓ timeline 解析/格式化/B站链接');

// ─────────────────────────  adapters  ─────────────────────────

{
  const srt = `1
00:00:01,000 --> 00:00:04,200
第一行
第二行

2
00:00:04,300 --> 00:00:09,800
<i>带标签</i> 文本

坏块没有时间行

3
00:00:10,000 --> 00:00:09,800
结束早于开始（应跳过）
`;
  const r = parseSrt(srt, { videoId: 'v1' });
  assert.equal(r.evidence.length, 2);
  assert.equal(r.evidence[0].rawText, '第一行 第二行');
  assert.equal(r.evidence[1].rawText, '带标签 文本');
  assert.equal(r.diagnostics.skipped, 2);
  assert.equal(r.evidence[0].id, 'v1#1');
}

{
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.200 align:start
第一句

NOTE 这是注释

00:00:04.300 --> 00:00:09.800
<v 倪师>第二句
`;
  const r = parseVtt(vtt, { videoId: 'v2' });
  assert.equal(r.evidence.length, 2);
  assert.equal(r.evidence[1].rawText, '第二句');
}

{
  const arr = parseSubtitleJson(
    JSON.stringify([
      { start: 0, end: 4.2, text: '甲' },
      { start: '00:00:05', text: '乙（无结束时间）' },
    ]),
    { videoId: 'v3' }
  );
  assert.equal(arr.evidence.length, 2);
  assert.equal(arr.evidence[1].tEndMs, null); // 结束时间不冒充
  const jsonl = parseSubtitleJson('{"start":"00:00:01","end":"00:00:02","text":"丙"}\n{"start":1,"text":"丁"}', { videoId: 'v3' });
  assert.equal(jsonl.evidence.length, 2);
}

{
  const jsonl = [
    { book: '03-bencao', part_name: '神农本草经', h2: '半夏（下品）', h3: '讲解判语', quote: '生半夏毒性大', bvid: 'BV1A', ep: 12, part: 1, section: 1, t_hms: '00:00:07', source_file: 'renji-03' },
    { book: '03-bencao', part_name: '神农本草经', h2: '半夏（下品）', h3: '讲解判语', quote: '一般用制半夏', bvid: 'BV1A', ep: 12, part: 1, section: 1, t_hms: '00:00:28', source_file: 'renji-03' },
    { book: '03-bencao', part_name: '神农本草经', h2: '大黄（下品）', h3: '讲解判语', quote: '大黄泻下', bvid: 'BV1A', ep: 12, part: 1, section: 2, t_hms: '00:02:00', source_file: 'renji-03' },
    { book: '04-neijing', part_name: '黄帝内经', h2: '篇一', h3: '讲解判语', quote: '上古天真论', bvid: 'BV2B', ep: 3, part: 1, section: 1, t_hms: '00:01:00', source_file: 'renji-04' },
  ].map((r) => JSON.stringify(r)).join('\n');
  const r = parseExcerptJsonl(jsonl, { contentType: 'shennong-bencao' });
  assert.equal(r.videos.length, 2);
  assert.equal(r.videos[0].videoId, '03-bencao-ep12');
  assert.equal(r.videos[0].mode, 'excerpt');
  assert.equal(r.videos[0].bvid, 'BV1A');
  assert.equal(r.evidence.length, 4);
  assert.equal(r.evidence[0].id, '03-bencao-ep12#1');
  assert.equal(r.evidence[0].tEndMs, null); // 关键：结束时间留空
  assert.equal(r.evidence[0].meta?.h2, '半夏（下品）');
  // 小样本：limitVideos / onlyVideoIds
  const limited = parseExcerptJsonl(jsonl, { limitVideos: 1 });
  assert.equal(limited.videos.length, 1);
  const only = parseExcerptJsonl(jsonl, { onlyVideoIds: ['04-neijing-ep3'] });
  assert.equal(only.evidence.length, 1);
  // 术语提取：h2 主名 + 多别名拆分
  const terms = extractExcerptTerms(jsonl);
  assert.ok(terms.some((t) => t.term === '半夏'));
  // 格式探测
  assert.equal(detectFormat(jsonl, 'entries.jsonl'), 'excerpt-jsonl');
  assert.equal(detectFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx', 'a.vtt'), 'vtt');
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nx', 'a.srt'), 'srt');
  assert.equal(detectFormat('[{"start":0,"text":"x"}]', 'a.json'), 'subtitle-json');
}
console.log('✓ 适配器 SRT/VTT/JSON/摘录JSONL + 格式探测');

// ─────────────────────────  glossary  ─────────────────────────

{
  const g = Glossary.fromText('# 注释\n苍术\n葶苈~\n');
  assert.equal(g.terms.length, 2);
  const m = g.match('苍术和葶苈一起用');
  assert.equal(m.length, 2);
  assert.equal(m[0].certainty, 'certain');
  assert.equal(m[1].certainty, 'uncertain');
  // 长词优先、不重叠
  const g2 = Glossary.fromText('附子\n附子汤\n');
  const m2 = g2.match('附子汤与附子不同');
  assert.equal(m2[0].term, '附子汤');
  assert.equal(m2.length, 2);
}
console.log('✓ 术语词表匹配');

// ─────────────────────────  clean  ─────────────────────────

{
  // 噪声丢弃 + 短窗口去重
  const r = clean([
    ev('v', 0, 1000, '（鼓掌）'),
    ev('v', 1000, 2000, '嗯嗯'),
    ev('v', 2000, 3000, '同一个文本'),
    ev('v', 2500, 3500, '同一个文本'),
    ev('v', 3000, 4000, '正常内容在这里。'),
  ], 'full_transcript');
  assert.equal(r[0].dropped, 'noise');
  assert.equal(r[1].dropped, 'noise');
  assert.equal(r[3].dropped, 'duplicate');
  assert.ok(r[4].cleanText.includes('正常内容'));
}

{
  // 完整字幕：合并明显断行；合并行保留对应关系
  const r = clean([
    ev('v', 0, 1000, '我们把那个'),
    ev('v', 1100, 2000, '生半夏放在袋子里。'),
    ev('v', 3000, 4000, '这是独立的一句。'),
  ], 'full_transcript');
  assert.equal(r[0].cleanText, '我们把那个生半夏放在袋子里。');
  assert.equal(r[1].mergedInto, r[0].id);
  assert.ok(r[0].cleanOps.some((op) => op.startsWith('merge:')));
}

{
  // 摘录模式：永不合并短引文
  const r = clean([
    excerptEv('v', 1, 0, '短引文一', { h2: '半夏' }),
    excerptEv('v', 2, 30_000, '短引文二', { h2: '半夏' }),
  ], 'excerpt');
  assert.equal(r[0].mergedInto, undefined);
  assert.equal(r[1].mergedInto, undefined);
}

{
  // 存疑术语只打标记，不改写文本
  const g = Glossary.fromText('葶苈~');
  const r = clean([ev('v', 0, 1000, '葶苈子泻肺平喘。')], 'full_transcript', g);
  assert.equal(r[0].cleanText, '葶苈子泻肺平喘。');
  assert.deepEqual(r[0].reviewFlags, ['uncertain-term:葶苈']);
}

{
  // 否定/条件/数值不被清洗删除
  const r = clean([ev('v', 0, 1000, '但是，如果没有恶心，1钱就够，不要超过3钱。')], 'full_transcript');
  assert.equal(r[0].cleanText, '但是，如果没有恶心，1钱就够，不要超过3钱。');
}
console.log('✓ 清洗：噪声/去重/断行合并/词表标记/内容保留');

// ─────────────────────────  segment  ─────────────────────────

function excerptVideo(): VideoMeta {
  return {
    videoId: '03-bencao-ep12',
    courseId: '03-bencao',
    courseName: '神农本草经',
    bvid: 'BV1A',
    cid: null,
    part: 1,
    title: '神农本草经 第 12 集',
    mode: 'excerpt',
    contentType: 'shennong-bencao',
    license: 'CC BY-NC-SA 4.0',
    source: 'test',
    importVersion: 'v1',
  };
}

{
  // 摘录：按 h2 分章节；段内 30s 采样间隔不切分；130s 大缺口强制断开
  const evidence = [
    excerptEv('03-bencao-ep12', 1, 0, '生半夏毒性大，一般用制半夏。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 2, 30_000, '生半夏放在袋子里面可以驱虫。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 3, 60_000, '半夏泻心汤里有半夏。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 4, 190_000, '制半夏经过炮制毒性降低。', { h2: '半夏' }), // 130s 缺口
    excerptEv('03-bencao-ep12', 5, 220_000, '法半夏燥湿化痰。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 6, 300_000, '大黄泻下攻积。', { h2: '大黄' }),
    excerptEv('03-bencao-ep12', 7, 330_000, '大黄不能久煎。', { h2: '大黄' }),
  ];
  const r = segmentVideo(clean(evidence, 'excerpt'), excerptVideo(), getConfig('shennong-bencao'));
  assert.equal(r.chapters.length, 2); // 半夏 / 大黄
  assert.equal(r.chapters[0].title, '半夏');
  assert.equal(r.chapters[0].detection, 'source-field');
  // 半夏章被 130s 缺口切成两段；大黄章一段
  const banxia = r.segments.filter((s) => s.chapterId === r.chapters[0].id);
  assert.equal(banxia.length, 2);
  assert.deepEqual(banxia[0].evIds, ['03-bencao-ep12#1', '03-bencao-ep12#2', '03-bencao-ep12#3']);
  assert.equal(banxia[0].tStartMs, 0);
  assert.equal(banxia[0].tEndMs, null); // 摘录无结束时间
  assert.equal(banxia[1].gapBeforeMs, 130_000); // 缺口被记录而非掩盖
  assert.equal(banxia[0].completeness, 'partial'); // 摘录永不冒充完整
  assert.equal(r.coverage.duplicateIds.length, 0);
  assert.equal(r.coverage.skippedIds.length, 0);
  // 章节类型识别：视频级已是 shennong-bencao → 章节继承（null），不重复判定
  assert.equal(r.chapters[0].contentType, null);
  assert.equal(banxia[0].contentType, 'shennong-bencao');
  assert.equal(displayTitle('半夏（下品草部；本11 口称267 未展开之后）'), '半夏');
}

{
  // 通用讲解视频里出现原书讲解特征 → 章节级切换配置（不写死课程结构）
  const evidence = [
    ev('v', 0, 5000, '今天我们看《神农本草经》的原文。'),
    ev('v', 5000, 10_000, '半夏味辛平，主治伤寒寒热。'),
    ev('v', 10_000, 15_000, '倪师在这里强调了生半夏和制半夏的区别。'),
  ];
  const video: VideoMeta = {
    videoId: 'v',
    courseId: 'misc',
    courseName: '杂谈',
    bvid: 'BV1Z',
    cid: null,
    part: 1,
    title: '杂谈',
    mode: 'full_transcript',
    contentType: 'generic-lecture',
    license: '',
    source: 'test',
    importVersion: 'v1',
  };
  const r = segmentVideo(clean(evidence, 'full_transcript'), video, getConfig('generic-lecture'));
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].contentType, 'shennong-bencao'); // 章节识别切换
  assert.equal(r.segments[0].contentType, 'shennong-bencao');
}

{
  // 完整字幕：句界完整才收段；超 refDuration 且不完整 → needs_context
  const evidence = [
    ev('v', 0, 5000, '光圈控制的是进光孔的大小，同时也会影响景深的深浅，这是曝光三角的第一边。'),
    ev('v', 5000, 10_000, '光圈数值越小，比如f1.8的时候，孔径越大，进光量越多，背景就越模糊。'),
    ev('v', 10_000, 15_000, '我们来看下一个概念，快门。'),
    ev('v', 15_000, 20_000, '快门控制曝光时间，安全快门的经验法则是焦距的倒数，比如50毫米镜头不要慢于1/50秒。'),
    ev('v', 60_000, 65_000, '这是缺口之后的新话题，讲ISO增益，ISO越高画面越亮，但是噪点也越多。'), // 50s 间隔 > 15s
    ev('v', 65_000, 70_000, '现代相机在ISO 6400以下通常完全可用，除非你刻意追求胶片颗粒感。'),
  ];
  const video: VideoMeta = { ...excerptVideo(), videoId: 'v', mode: 'full_transcript', contentType: 'generic-lecture' };
  const r = segmentVideo(clean(evidence, 'full_transcript'), video, getConfig('generic-lecture'));
  assert.ok(r.segments.length >= 2);
  const first = r.segments[0];
  assert.equal(first.tStartMs, 0);
  assert.equal(first.tEndMs, 10_000); // 口头切换语「我们来看…快门」归入后一段
  assert.equal(first.completeness, 'complete');
  assert.equal(first.status, 'ok');
  // 切换语与其后内容同段（快门概念两句；49 字 < minChars → needs_context 如实标记）
  assert.equal(r.segments[1].evIds.length, 2);
  assert.equal(r.segments[1].tEndMs, 20_000);
  assert.equal(r.segments[1].completeness, 'needs_context');
  const afterGap = r.segments.find((s) => s.tStartMs === 60_000);
  assert.ok(afterGap);
  assert.ok((afterGap.gapBeforeMs ?? 0) >= 45_000);
}
console.log('✓ 切分：章节识别/摘录缺口保护/句界完整/覆盖检查');

// ─────────────────────────  summarize + card  ─────────────────────────

{
  const evidence = [
    excerptEv('03-bencao-ep12', 1, 0, '生半夏毒性大，一般用制半夏，剂量不可以超过3钱。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 2, 30_000, '但是如果没有恶心，1钱就够。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 3, 60_000, '半夏泻心汤里有半夏，用来降逆止呕。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 4, 90_000, '法半夏燥湿化痰的效果更好一些。', { h2: '半夏' }),
  ];
  const cleaned = clean(evidence, 'excerpt', Glossary.fromText('半夏\n大黄\n'));
  const r = segmentVideo(cleaned, excerptVideo(), getConfig('shennong-bencao'));
  const seg = r.segments[0];
  const byId = new Map(cleaned.map((e) => [e.id, e]));
  const draft = summarizeSegment(seg, byId, excerptVideo(), getConfig('shennong-bencao'), Glossary.fromText('半夏\n大黄\n'));
  assert.equal(draft.title, '半夏');
  assert.ok(draft.summary.length > 0);
  assert.ok(draft.keywords.includes('半夏'));
  assert.equal(draft.typeFields.viewpoint, 'speaker'); // 讲者观点标记
  assert.ok(Array.isArray(draft.typeFields.herbs));
  // 每个要点都能在原字幕中找到依据（无编造）
  for (const p of draft.points) {
    assert.ok(p.evIds.length > 0, '要点必须带字幕 ID');
    const support = p.evIds.map((id) => byId.get(id)?.cleanText ?? '').join('');
    assert.ok(containmentRatio(p.text, support) >= 0.6, `要点无依据: ${p.text}`);
  }
  // 信息不足 → needs_context
  const thin = summarizeSegment(
    { ...seg, evIds: ['03-bencao-ep12#4'], internalGapsMs: [] },
    byId,
    excerptVideo(),
    getConfig('shennong-bencao'),
    null
  );
  assert.equal(thin.needsContext, true);
  // 整理文本不增加事实：body 字符全部来自字幕
  const allText = evidence.map((e) => e.rawText).join('');
  const bodyChars = new Set([...draft.body.replace(/[\s，。！？、]/g, '')]);
  const sourceChars = new Set([...allText.replace(/[\s，。！？、]/g, '')]);
  for (const ch of bodyChars) {
    assert.ok(sourceChars.has(ch), `body 引入了原文没有的字: ${ch}`);
  }
  const card = buildCard(seg, draft, excerptVideo());
  assert.equal(card.genMode, 'extractive');
  assert.equal(card.quality, 'needs_review'); // 摘录+内部有间隔 → 待复核
}
console.log('✓ 摘要：要点可溯源/无编造/needs_context/讲者观点标记');

// ─────────────────────────  validate  ─────────────────────────

{
  const video = excerptVideo();
  const evidence = [
    excerptEv('03-bencao-ep12', 1, 0, '生半夏毒性大，一般用制半夏入药。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 2, 30_000, '但是剂量不可以超过3钱，也不可以生用。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 3, 60_000, '如果没有恶心，1钱起步即可。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 4, 90_000, '半夏泻心汤用它降逆止呕。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 5, 120_000, '法半夏燥湿化痰的效果更好。', { h2: '半夏' }),
  ];
  const cleaned = clean(evidence, 'excerpt');
  const byId = new Map(cleaned.map((e) => [e.id, e]));
  const r = segmentVideo(cleaned, video, getConfig('shennong-bencao'));
  const draft = summarizeSegment(r.segments[0], byId, video, getConfig('shennong-bencao'), null);
  const card = buildCard(r.segments[0], draft, video);

  // 1) 正常卡片通过
  const ok = validateCard(card, { evidenceById: byId, videosById: new Map([[video.videoId, video]]), configFor: getConfig });
  assert.equal(ok.quality, 'validated', JSON.stringify(ok.issues));

  // 2) 摘录冒充完整 → error
  const masquerade = validateCard(
    { ...card, completeness: 'complete' },
    { evidenceById: byId, videosById: new Map([[video.videoId, video]]), configFor: getConfig }
  );
  assert.ok(masquerade.issues.some((i) => i.code === 'excerpt-masquerade'));
  assert.equal(masquerade.quality, 'needs_review');

  // 3) 摘要无依据 → error（编造一句原文没有的话）
  const fabricated = validateCard(
    {
      ...card,
      points: [{ text: '倪师说半夏可以治愈肺癌。', evIds: ['03-bencao-ep12#1'] }],
      summary: '倪师说半夏可以治愈肺癌。',
    },
    { evidenceById: byId, videosById: new Map([[video.videoId, video]]), configFor: getConfig }
  );
  assert.ok(fabricated.issues.some((i) => i.code === 'summary-unsupported'));

  // 4) 时间非法 → rejected
  const badTime = validateCard(
    { ...card, tEndMs: 0 },
    { evidenceById: byId, videosById: new Map([[video.videoId, video]]), configFor: getConfig }
  );
  assert.ok(badTime.issues.some((i) => i.code === 'time-illegal'));
  assert.equal(badTime.quality, 'rejected');

  // 5) 字幕不存在 → rejected
  const badEv = validateCard(
    { ...card, evIds: ['03-bencao-ep12#999'] },
    { evidenceById: byId, videosById: new Map([[video.videoId, video]]), configFor: getConfig }
  );
  assert.ok(badEv.issues.some((i) => i.code === 'evidence-not-found'));
  assert.equal(badEv.quality, 'rejected');

  // 6) 跨段重复覆盖 → error
  const overlap = validateCard(
    card,
    { evidenceById: byId, videosById: new Map([[video.videoId, video]]), configFor: getConfig },
    [{ ...card, id: 'other-seg' }]
  );
  assert.ok(overlap.issues.some((i) => i.code === 'coverage-overlap'));

  // 7) 否定丢失告警：证据里 2 次「不可以」，摘要和 body 都没有
  const negLoss = validateCard(
    { ...card, summary: '生半夏一般用制半夏。', body: '生半夏一般用制半夏。' },
    { evidenceById: byId, videosById: new Map([[video.videoId, video]]), configFor: getConfig }
  );
  assert.ok(negLoss.issues.some((i) => i.code === 'possible-negation-loss' && i.severity === 'warn'));
}

{
  // 完整字幕模式：段内序号跳号 → coverage-gap error（正常连续 → validated）
  const video: VideoMeta = { ...excerptVideo(), videoId: 'v', mode: 'full_transcript' };
  const cleaned = clean(
    [
      ev('v', 0, 5000, '第一句完整的话在这里。'),
      ev('v', 5000, 10_000, '第二句完整的话在这里。'),
    ],
    'full_transcript'
  );
  const byId = new Map(cleaned.map((e) => [e.id, e]));
  const card = buildCard(
    {
      id: 'v-s001',
      videoId: 'v',
      chapterId: 'v-c001',
      contentType: 'generic-lecture',
      title: 't',
      chapterRaw: 't',
      evIds: cleaned.map((e) => e.id),
      tStartMs: 0,
      tEndMs: 10_000,
      gapBeforeMs: null,
      internalGapsMs: [],
      completeness: 'complete',
      status: 'ok',
      pipelineVersion: 'test',
    },
    {
      title: 't',
      summary: '第一句完整的话在这里。',
      points: [{ text: '第一句完整的话在这里。', evIds: [cleaned[0].id] }],
      body: '第一句完整的话在这里。第二句完整的话在这里。',
      keywords: [],
      typeFields: {},
      needsContext: false,
      notes: [],
    },
    video
  );
  const r = validateCard(card, { evidenceById: byId, videosById: new Map([['v', video]]), configFor: getConfig });
  assert.equal(r.quality, 'validated', JSON.stringify(r.issues));

  // 序号跳号（中间缺一条）→ coverage-gap
  const byIdGap = new Map(byId);
  byIdGap.set(cleaned[1].id, { ...cleaned[1], seq: 5 });
  const rg = validateCard(card, { evidenceById: byIdGap, videosById: new Map([['v', video]]), configFor: getConfig });
  assert.ok(rg.issues.some((i) => i.code === 'coverage-gap'), JSON.stringify(rg.issues));
}
console.log('✓ 校验：字段/时间/依据/摘录冒充/重复覆盖/否定丢失');

// ─────────────────────────  chunk + cache  ─────────────────────────

{
  const video = excerptVideo();
  const evidence = [
    excerptEv('03-bencao-ep12', 1, 0, '生半夏毒性大，一般用制半夏，不可以超过3钱。', { h2: '半夏' }),
    excerptEv('03-bencao-ep12', 2, 30_000, '但是如果没有恶心，1钱就够。', { h2: '半夏' }),
  ];
  const cleaned = clean(evidence, 'excerpt');
  const byId = new Map(cleaned.map((e) => [e.id, e]));
  const r = segmentVideo(cleaned, video, getConfig('shennong-bencao'));
  const draft = summarizeSegment(r.segments[0], byId, video, getConfig('shennong-bencao'), null);
  const card = buildCard(r.segments[0], draft, video);
  const chunks = chunkCard(card);
  assert.ok(chunks.some((c) => c.kind === 'head'));
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.equal(c.segmentId, card.segmentId); // 统一关联父 segment
    assert.ok(c.text.length > 0);
  }
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length); // ID 稳定唯一
}

{
  const h1 = contentHash({ a: 1, b: [1, 2] });
  const h2 = contentHash({ b: [1, 2], a: 1 });
  assert.equal(h1, h2); // 稳定序列化
  assert.notEqual(h1, contentHash({ a: 2, b: [1, 2] }));
  const k1 = stageKey('card', CONFIG_VERSION, [{ id: 'v', hash: h1 }]);
  const k2 = stageKey('card', CONFIG_VERSION, [{ id: 'v', hash: h1 }]);
  const k3 = stageKey('card', CONFIG_VERSION, [{ id: 'v', hash: contentHash({ changed: true }) }]);
  assert.equal(k1, k2);
  assert.notEqual(k1, k3); // 上游变化 → 下游缓存键变化（自动失效）
}
console.log('✓ 检索块/缓存键');

// ─────────────────────────  config  ─────────────────────────

{
  assert.equal(getConfig('shennong-bencao').glossaryFile, 'data/vk/glossaries/shennong-bencao-herbs.txt');
  assert.equal(getConfig('shennong-bencao').name, '神农本草经讲解');
  assert.ok(getConfig('book-commentary').structuredFields.some((f) => f.name === 'passage_ref'));
  assert.ok(CONFIG_VERSION.length > 0);
  // 章节识别：本草经章节 → shennong-bencao；无关章节 → null（不强行分类）
  const t1 = detectChapterType('半夏（下品）', '生半夏毒性大一般用制半夏', ['book-commentary', 'shennong-bencao']);
  assert.equal(t1, 'shennong-bencao');
  const t2 = detectChapterType('相机曝光', '光圈控制进光孔的大小', ['book-commentary', 'shennong-bencao']);
  assert.equal(t2, null);
}
console.log('✓ 配置体系：继承/词表/章节识别');

console.log('\n视频知识流水线单元测试全部通过');
