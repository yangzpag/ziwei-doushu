'use client';

/**
 * 知识库检索页：问题 → 路由（查库/直答）→ 带引用的回答 + 段落卡片（可跳转视频那一秒）。
 * 段落来自 kb_segment（按话题分组，起止时间由程序从句子时间戳计算）。
 */
import { useState } from 'react';
import TopBar from '@/components/v2/TopBar';
import s from './kb.module.css';

interface SegmentOut {
  n: number;
  segment_id: string;
  title: string;
  course: string;
  time_range: string;
  jump_url: string;
  text_preview: string;
  score: number;
}

interface AskResult {
  mode: 'rag' | 'direct';
  answer: string;
  route: { decision: string; score: number; reason: string };
  segments: SegmentOut[];
  note?: string;
}

/** 回答里的 [1][2] 引用 → 可点击角标（打开对应段落的视频跳转） */
function renderAnswer(answer: string, segments: SegmentOut[]) {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((p, i) => {
    const m = p.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{p}</span>;
    const seg = segments[Number(m[1]) - 1];
    if (!seg) return <span key={i}>{p}</span>;
    return (
      <a
        key={i}
        className={s.cite}
        href={seg.jump_url}
        target="_blank"
        rel="noreferrer"
        title={`${seg.title} · ${seg.time_range}`}
      >
        [{m[1]}]
      </a>
    );
  });
}

export default function KbSearch() {
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState('');

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text) return;
    setPhase('loading');
    setError('');
    try {
      const res = await fetch('/api/kb/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d?.message ?? '检索失败');
        setPhase('error');
        return;
      }
      setResult(d);
      setPhase('done');
    } catch {
      setError('网络异常，请重试');
      setPhase('error');
    }
  };

  const examples = ['半夏止恶心配什么药', '便秘可以用大黄吗', '条336讲什么', '失眠怎么治', '甘遂是做什么用的'];

  return (
    <div className={s.page}>
      <TopBar active="tcm" />
      <div className="wrap">
        <div className={s.head}>
          <p className={s.eyebrow}>TCM KNOWLEDGE · SEGMENT RETRIEVAL</p>
          <h1>中医知识库</h1>
          <p className={s.sub}>
            按语义段落检索倪海厦《人纪》讲课内容。回答每个论点都带引用编号，点引用或「回放那一秒」直接跳到 B 站原视频对应时间。
          </p>
        </div>

        <div className={s.searchRow}>
          <input
            className={s.input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void ask(q);
            }}
            placeholder="提问或搜索：药名、方剂、症状、条文……"
            autoComplete="off"
          />
          <button className={s.btn} onClick={() => void ask(q)} disabled={phase === 'loading' || !q.trim()}>
            {phase === 'loading' ? '思考中…' : '提问'}
          </button>
        </div>

        <div className={s.examples}>
          <span>试试：</span>
          {examples.map((e) => (
            <button key={e} className={s.exBtn} onClick={() => { setQ(e); void ask(e); }}>
              {e}
            </button>
          ))}
        </div>

        {phase === 'error' && (
          <div className={s.err}>
            {error}
            <button className={s.retry} onClick={() => void ask(q)}>重试</button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className={s.result}>
            <div className={`${s.badge} ${result.mode === 'rag' ? s.badgeRag : s.badgeDirect}`}>
              {result.mode === 'rag'
                ? `🧭 已查课程库 · top1 相似度 ${result.route.score.toFixed(2)} · 依据 ${result.segments.length} 个段落`
                : `💬 直接回答 · ${result.route.reason}`}
            </div>

            <div className={s.answer}>{renderAnswer(result.answer, result.segments)}</div>

            {result.note && <div className={s.note}>{result.note}</div>}

            {result.segments.length > 0 && (
              <>
                <div className={s.segTitle}>引用段落（点击跳转到视频那一秒）</div>
                {result.segments.map((seg) => (
                  <div key={seg.segment_id} className={s.segCard}>
                    <div className={s.segTop}>
                      <span className={s.segN}>{seg.n}</span>
                      <span className={s.segName}>{seg.title}</span>
                      <span className={s.segMeta}>
                        {seg.course} · {seg.time_range} · 相似度 {seg.score.toFixed(2)}
                      </span>
                      {seg.jump_url && (
                        <a className={s.jump} href={seg.jump_url} target="_blank" rel="noreferrer">
                          ▶ 回放那一秒
                        </a>
                      )}
                    </div>
                    <div className={s.segText}>{seg.text_preview}…</div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        <p className={s.foot}>
          说明：当前语料为讲课摘录（非完整逐字稿），段落文本为摘录拼接，完整内容请点回放看原视频；课程内容为讲者观点，仅供学习参考。
        </p>
      </div>
    </div>
  );
}
