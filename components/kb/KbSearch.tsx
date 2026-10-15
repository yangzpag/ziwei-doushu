'use client';

/**
 * 知识库问答页 —— 结构/样式移植自《中医知识库.html》设计稿的「课程对话页」，
 * 但去掉设计稿的课程归属结构（面包屑、课程标题、大纲侧栏、课程卡片）：
 * 对话打平，不隶属于任何课程；课程只是每条提问的检索范围（输入框上的「问答范围」选择器）。
 */
import { useState, useRef, useEffect } from 'react';
import TopBar from '@/components/v2/TopBar';
import { COURSES } from '@/lib/kb/courses';
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

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  /** 提问时携带的课程范围（null = 全部课程） */
  courseId?: string | null;
  route?: { decision: string; score: number; reason: string };
  aiAvailable?: boolean;
  note?: string;
  segments?: SegmentOut[];
  failed?: boolean;
}

const EXAMPLES = ['湿疹怎么治疗', '半夏止恶心配什么药', '条336讲什么', '便秘可以用大黄吗', '失眠怎么治'];

/** 回答里的 [1][2] 引用 → 设计稿 .cite 小角标（点击打开对应段落的视频跳转） */
function renderAnswer(answer: string, segments: SegmentOut[]) {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((p, i) => {
    const m = p.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{p}</span>;
    const seg = segments[Number(m[1]) - 1];
    if (!seg) return <span key={i}>{p}</span>;
    return (
      <a key={i} className={s.cite} href={seg.jump_url} target="_blank" rel="noreferrer" title={`${seg.title} · ${seg.time_range}`}>
        {m[1]}
      </a>
    );
  });
}

export default function KbSearch() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [courseId, setCourseId] = useState<string | null>(null); // null = 全部课程
  const [scopeOpen, setScopeOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || loading) return;
    setQ('');
    const scope = courseId;
    setMessages((prev) => [...prev, { role: 'user', text, courseId: scope }]);
    setLoading(true);
    try {
      const res = await fetch('/api/kb/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, course: scope ?? undefined }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', text: d?.message ?? '检索失败，请重试', failed: true }]);
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: d.answer ?? '',
          route: d.route,
          aiAvailable: d.aiAvailable,
          note: d.note,
          segments: d.segments ?? [],
        },
      ]);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', text: '网络异常，请重试', failed: true }]);
    } finally {
      setLoading(false);
    }
  };

  const scopeLabel = courseId ? (COURSES.find((c) => c.id === courseId)?.name ?? courseId) : '全部课程';
  const empty = messages.length === 0;

  return (
    <div className={s.page}>
      <TopBar active="tcm" />
      <div className="wrap">
        <div className={s.head}>
          <p className={s.eyebrow}>TCM KNOWLEDGE BASE</p>
          <h1>中医知识库</h1>
          <p className={s.sub}>
            按语义段落检索倪海厦《人纪》讲课内容。对话打平——课程只是每条提问的检索范围，随时换，历史不归任何课程所有。
            回答论点带引用角标，点角标或「回放那一秒」跳到 B 站原视频对应时间。
          </p>
        </div>

        {/* 对话流（设计稿 .chat / .chat-scroll / .msg） */}
        <div className={s.chat}>
          <div className={s.chatScroll}>
            {empty && (
              <div className={s.threadEmpty}>
                <p>开始提问，比如：</p>
                <div className={s.chipsRow}>
                  {EXAMPLES.map((e) => (
                    <button key={e} className={s.chip} onClick={() => void ask(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className={s.userRow}>
                  <div className={s.userBubble}>
                    {m.text}
                    {m.courseId && <span className={s.userScope}>{COURSES.find((c) => c.id === m.courseId)?.name ?? m.courseId}</span>}
                  </div>
                </div>
              ) : (
                <div key={i} className={`${s.assistantRow} ${m.failed ? s.assistantFailed : ''}`}>
                  <div className={s.aiTag}>{m.failed ? '倪师 · 出错了' : m.aiAvailable === false ? '倪师 · 语料直检' : '倪师 · AI'}</div>
                  <div className={s.aiBody}>
                    {m.route && (
                      <div className={`${s.badge} ${m.route.decision === 'rag' ? s.badgeRag : s.badgeDirect}`}>
                        {m.route.decision === 'rag'
                          ? `🧭 已查课程库 · top1 相似度 ${m.route.score.toFixed(2)} · ${m.segments?.length ?? 0} 个段落`
                          : `💬 直接回答 · ${m.route.reason}`}
                      </div>
                    )}
                    <div className={s.answer}>{m.failed ? m.text : renderAnswer(m.text, m.segments ?? [])}</div>
                    {m.note && <div className={s.note}>{m.note}</div>}
                    {(m.segments?.length ?? 0) > 0 && (
                      <>
                        <div className={s.segTitle}>引用段落（点角标或回放跳到视频那一秒）</div>
                        {m.segments!.map((seg) => (
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
                </div>
              )
            )}

            {loading && (
              <div className={s.assistantRow}>
                <div className={s.aiTag}>倪师 · 思考中</div>
                <div className={s.aiBody}>…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* 输入区：设计稿 .chat-input / .input-row / .scope-sel */}
          <div className={s.chatInput}>
            {empty && (
              <div className={s.chipsRow}>
                {EXAMPLES.map((e) => (
                  <button key={e} className={s.chip} onClick={() => void ask(e)}>
                    {e}
                  </button>
                ))}
              </div>
            )}
            <div className={s.inputRow}>
              <div className={s.scopeSel}>
                <button
                  type="button"
                  className={`${s.scopeBtn} ${courseId ? s.scopeBtnOn : ''}`}
                  onClick={() => setScopeOpen((v) => !v)}
                >
                  问答范围：{scopeLabel} <span>{scopeOpen ? '▲' : '▼'}</span>
                </button>
                {scopeOpen && (
                  <div className={s.scopeMenu}>
                    <button
                      type="button"
                      className={`${s.scopeItem} ${courseId === null ? s.scopeItemOn : ''}`}
                      onClick={() => {
                        setCourseId(null);
                        setScopeOpen(false);
                      }}
                    >
                      全部课程
                    </button>
                    {COURSES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`${s.scopeItem} ${courseId === c.id ? s.scopeItemOn : ''}`}
                        onClick={() => {
                          setCourseId(c.id);
                          setScopeOpen(false);
                        }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void ask(q);
                }}
                placeholder={courseId ? `问《${scopeLabel}》点什么……` : '问点什么……如「太阳中风是什么道理」'}
                autoComplete="off"
                disabled={loading}
              />
              <button className={s.btnSolid} onClick={() => void ask(q)} disabled={loading || !q.trim()}>
                问 倪 师
              </button>
            </div>
          </div>
        </div>

        <p className={s.chatFoot}>
          当前回答模式：<b>{messages.some((m) => m.aiAvailable === false) ? '语料直检' : '大模型语义回答'}</b>
          ——AI 不可用时自动降级为命中段落原文（检索、引用、回放不变）。回答仅供传统文化学习参考，不构成医疗建议。
        </p>

        <p className={s.foot}>
          语料来源：nihai-renji-corpus（CC BY-NC-SA 4.0，仅限非商业用途）；原课程内容版权归倪海厦先生及其权利继承人所有。
          当前语料为讲课摘录（非完整逐字稿），段落文本为摘录拼接，完整内容请点回放看原视频。
        </p>
      </div>
    </div>
  );
}
