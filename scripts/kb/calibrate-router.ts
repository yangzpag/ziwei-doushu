#!/usr/bin/env tsx
/**
 * 路由器阈值校准：用一组「相关/无关/跨域」问题打 top-1 相似度，
 * 看分数分布，定 RAG 路由阈值。
 *
 *   DATABASE_URL=… EMBED_URL=http://127.0.0.1:3001 tsx scripts/kb/calibrate-router.ts
 */
import pg from 'pg';

const EMBED_URL = process.env.EMBED_URL ?? 'http://127.0.0.1:3001';

const GROUPS: { label: string; queries: string[] }[] = [
  {
    label: '相关（课程内，应走 RAG）',
    queries: ['半夏止恶心配什么药', '便秘可以用大黄吗', '甘遂是做什么用的', '条336讲什么', '失眠怎么治', '针灸下针手法', '桂枝汤的组成'],
  },
  {
    label: '无关（日常闲聊，应直答）',
    queries: ['今天天气怎么样', '帮我写个周报', 'NBA比分', '怎么学编程', '推荐几部电影'],
  },
  {
    label: '跨域（本站其他功能，应直答）',
    queries: ['紫微斗数怎么排盘', '三方四正是什么', '我的命盘里天机星代表什么'],
  },
];

async function embedQuery(q: string): Promise<number[]> {
  const res = await fetch(`${EMBED_URL.replace(/\/$/, '')}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: [q] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`embed-server ${res.status}`);
  const { vectors } = (await res.json()) as { vectors: number[][] };
  return vectors[0];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const scores: { label: string; q: string; s1: number; s2: number; title: string; course: string }[] = [];
  for (const g of GROUPS) {
    for (const q of g.queries) {
      const vec = await embedQuery(q);
      const { rows } = await client.query<{ title: string; course_id: string; score: string; score2: string }>(
        `SELECT title, course_id, 1 - (embedding <=> $1::vector) AS score,
                (SELECT 1 - (embedding <=> $1::vector) FROM kb_segment ORDER BY embedding <=> $1::vector OFFSET 1 LIMIT 1) AS score2
           FROM kb_segment ORDER BY embedding <=> $1::vector LIMIT 1`,
        [`[${vec.join(',')}]`]
      );
      scores.push({
        label: g.label,
        q,
        s1: Number(rows[0].score),
        s2: Number(rows[0].score2),
        title: rows[0].title,
        course: rows[0].course_id,
      });
    }
  }
  for (const g of GROUPS) {
    console.log(`\n── ${g.label} ──`);
    for (const s of scores.filter((x) => x.label === g.label)) {
      console.log(`  ${s.s1.toFixed(3)}（top2 ${s.s2.toFixed(3)}）  ${s.q} → 「${s.title}」${s.course}`);
    }
  }
  const rel = scores.filter((s) => s.label.startsWith('相关')).map((s) => s.s1);
  const irr = scores.filter((s) => !s.label.startsWith('相关')).map((s) => s.s1);
  console.log(`\n相关最低 ${Math.min(...rel).toFixed(3)} ｜ 无关/跨域最高 ${Math.max(...irr).toFixed(3)}`);
  const gap = Math.min(...rel) - Math.max(...irr);
  console.log(gap > 0 ? `✅ 可分：阈值取 ${((Math.min(...rel) + Math.max(...irr)) / 2).toFixed(3)} 附近` : `⚠️ 有重叠（gap=${gap.toFixed(3)}），需引入二次判据（关键词/LLM 分类）`);
  await client.end();
}

main().catch((e) => {
  console.error('[calibrate] 失败:', e);
  process.exit(1);
});
