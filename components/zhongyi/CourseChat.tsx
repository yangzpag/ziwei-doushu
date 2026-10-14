'use client';

/**
 * 中医知识库 · 课程问答页（设计稿 viewCourse 移植）
 *
 * - 问答：POST /api/zhongyi/ask（pgvector 语义检索；embed 服务故障时自动降级关键词）
 * - 引用：每条判语可点出处编号 → 侧滑面板 → B 站秒级回放 / 复制链接
 * - 历史：localStorage 按课程存多轮对话（新对话 / 历史菜单 / 清空）
 * - 大纲：h2 主题列表，点击即问「xx 都讲了什么？」
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/v2/TopBar';
import s from './zhongyi.module.css';
import { BOOKS, bookMeta, biliUrl } from '@/lib/corpus/books';

interface Entry {
  id: string;
  book_id: string;
  h2: string;
  h3: string;
  quote: string;
  bvid: string;
  ep: number;
  t_hms: string;
}
interface Group { title: string; items: Entry[] }
interface Msg {
  role: 'user' | 'ai';
  text?: string;
  intro?: string;
  quotes?: Group[];
  foot?: string;
  mode?: 'vector' | 'keyword';
}
interface Conv { ts: number; msgs: Msg[] }

interface RefInfo {
  no: number;
  src: string;
  title: string;
  quote: string;
  url: string;
}

const HIST_KEY = (b: string) => `zhongyi_hist_${b}`;
const pad2 = (n: number) => String(n).padStart(2, '0');

function loadHist(book: string): Conv[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIST_KEY(book)) ?? 'null');
    if (Array.isArray(v) && v.every((c) => c && Array.isArray(c.msgs))) return v;
  } catch { /* 损坏则忽略 */ }
  return [];
}

function fmtWhen(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export default function CourseChat({ book, initialAsk }: { book: string; initialAsk?: string }) {
  const meta = bookMeta(book);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [active, setActive] = useState(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<string>(book);
  const [histOpen, setHistOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [ref, setRef] = useState<RefInfo | null>(null);
  const [outline, setOutline] = useState<{ h2: string; n: number }[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askedInit = useRef(false);

  const msgs = convs[active]?.msgs ?? [];

  /* ── 初始化：历史 / 大纲 ── */
  useEffect(() => {
    let loaded = loadHist(book);
    const last = loaded[loaded.length - 1];
    if (!last || last.msgs.length) loaded = [...loaded, { ts: Date.now(), msgs: [] }];
    setConvs(loaded);
    setActive(loaded.length - 1);
    fetch(`/api/zhongyi/outline?book=${encodeURIComponent(book)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setOutline(d?.items ?? []))
      .catch(() => setOutline([]));
  }, [book]);

  /* ── 欢迎语（空会话） ── */
  useEffect(() => {
    if (!convs.length || msgs.length) return;
    const intro: Msg = {
      role: 'ai',
      intro: `这里是《${meta?.name ?? book}》的问答。库里的倪师原话判语都在，问吧——回答会附出来处，点出处编号展开引用，可回放 B 站原视频的那一秒。`,
      quotes: [],
      foot: '',
    };
    patchActive((c) => ({ ...c, msgs: [intro] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convs.length, active]);

  /* ── 初始追问（首页搜索跳转带入） ── */
  useEffect(() => {
    if (askedInit.current || !initialAsk || !convs.length) return;
    askedInit.current = true;
    void ask(initialAsk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAsk, convs.length]);

  /* ── 持久化 + 滚动 ── */
  useEffect(() => {
    if (convs.length) {
      try { localStorage.setItem(HIST_KEY(book), JSON.stringify(convs)); } catch { /* 满额忽略 */ }
    }
  }, [convs, book]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, busy]);

  function patchActive(fn: (c: Conv) => Conv) {
    setConvs((prev) => prev.map((c, i) => (i === active ? fn(c) : c)));
  }

  const ask = useCallback(
    async (q: string) => {
      const question = q.trim();
      if (!question || busy) return;
      setInput('');
      patchActive((c) => ({ ...c, msgs: [...c.msgs, { role: 'user', text: question }] }));
      setBusy(true);
      const scopeBook = scope === 'ALL' ? undefined : scope;
      // 追问改写所需的对话历史（用户问 + AI 引用主题）
      const history = msgs.slice(-6).map((m) => ({
        role: m.role,
        text:
          m.role === 'user'
            ? m.text ?? ''
            : `${m.intro ?? ''} ${(m.quotes ?? [])
                .flatMap((g) => g.items.map((r) => r.quote))
                .slice(0, 3)
                .join(' ')}`.slice(0, 200),
      }));
      try {
        const res = await fetch('/api/zhongyi/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: question, book: scopeBook, history }),
        });
        const d = res.ok ? await res.json() : null;
        const groups: Group[] = d?.groups ?? [];
        if (!groups.length) {
          const scopeName = scope === 'ALL' ? '全库六部' : meta?.name ?? '';
          patchActive((c) => ({
            ...c,
            msgs: [...c.msgs, {
              role: 'ai',
              intro: `「${scopeName}」里没有找到接近的判语。试试更短的词（方剂名、药名、穴位名更容易命中），或把问答范围切到「全库六部」。`,
              quotes: [],
              foot: '',
            }],
          }));
          return;
        }
        // 原著原文意图：语料是讲座口语、不含古籍原文——诚实说明，仍给讲解与指引
        if (d?.wantsOriginal) {
          patchActive((c) => ({
            ...c,
            msgs: [
              ...c.msgs,
              {
                role: 'ai',
                intro:
                  '本库收录的是倪师讲座的口语录**（不含古籍原文）**，无法直接给出《伤寒论》等原典文本。以下是倪师讲到相关内容时的讲解，可作参考；查原文请以原典为准（如中国哲学书电子化计划 ctext.org）。',
                quotes: [],
                foot: '',
              },
            ],
          }));
        }
        const lead = groups[0].items[0].h2;
        const scopeName = scope === 'ALL' ? '全库六部' : meta?.name ?? '';
        patchActive((c) => ({
          ...c,
          msgs: [
            ...c.msgs,
            {
              role: 'ai',
              intro:
                (d?.rewritten ? `<span style="opacity:.7">已按「${d.rewritten}」检索 · </span>` : '') +
                `在<b>${scopeName}</b>的<b>${lead}</b>附近，倪师是这样讲的：`,
              quotes: groups,
              foot: d?.foot ?? '',
              mode: d?.mode,
            },
          ],
        }));
      } catch {
        patchActive((c) => ({
          ...c,
          msgs: [...c.msgs, { role: 'ai', intro: '检索失败，请稍后重试。', quotes: [], foot: '' }],
        }));
      } finally {
        setBusy(false);
      }
    },
    [busy, scope, meta?.name, active, msgs]
  );

  function newConv() {
    if (msgs.length) {
      setConvs((prev) => [...prev, { ts: Date.now(), msgs: [] }]);
      setActive(convs.length);
    }
    setHistOpen(false);
  }

  function clearHist() {
    try { localStorage.removeItem(HIST_KEY(book)); } catch { /* ignore */ }
    setConvs([{ ts: Date.now(), msgs: [] }]);
    setActive(0);
    setHistOpen(false);
  }

  /* ── 引用编号：渲染时为每条 ai 消息平铺 quotes ── */
  const refs = useMemo(() => {
    const out: Entry[] = [];
    for (const m of msgs) (m.quotes ?? []).forEach((g) => g.items.forEach((r) => out.push(r)));
    return out;
  }, [msgs]);

  /** 消息内引用基线（该消息之前的引用总数），用于 [n] 编号定位 */
  const bases = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const m of msgs) {
      out.push(acc);
      acc += (m.quotes ?? []).reduce((a, g) => a + g.items.length, 0);
    }
    return out;
  }, [msgs]);

  function openRef(i: number) {
    const r = refs[i];
    if (!r) return;
    setRef({
      no: i + 1,
      src: `[${bookMeta(r.book_id)?.short ?? ''}${pad2(r.ep)} @${r.t_hms}]`,
      title: `${bookMeta(r.book_id)?.name ?? r.book_id} · ${r.h2}${r.h3 ? ' · ' + r.h3 : ''}`,
      quote: r.quote,
      url: biliUrl(r.bvid, r.t_hms),
    });
  }

  const scopeName = scope === 'ALL' ? '全库六部' : bookMeta(scope)?.name ?? '';

  if (!meta) {
    return <div className={s.loading}>课程不存在。<Link href="/zhongyi" style={{ color: 'inherit' }}>返回知识库</Link></div>;
  }

  return (
    <div className={s.page}>
      <TopBar active="tcm" />
      <div className="wrap">
        <div className={s.crumb}>
          <Link href="/zhongyi">中医知识库</Link>
          <span className={s.sep}>/</span>
          <span>{meta.name}</span>
        </div>
        <div className={s.courseHead}>
          <h1>{meta.name}</h1>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
            <div className={s.headActions}>
              <button className={`${s.btn} ${s.ghost} ${s.sm}`} onClick={newConv}>＋ 新对话</button>
              <button className={`${s.btn} ${s.ghost} ${s.sm}`} onClick={(e) => { e.stopPropagation(); setHistOpen((v) => !v); }}>
                历史对话 ▾
              </button>
              <div className={`${s.histMenu} ${histOpen ? s.open : ''}`} onClick={(e) => e.stopPropagation()}>
                {convs.length === 0 ? (
                  <div className={s.histEmpty}>本课程还没有对话记录</div>
                ) : (
                  <>
                    {convs.map((c, i) => (
                      <div
                        key={i}
                        className={`${s.histItem} ${i === active ? 'on' : ''}`}
                        onClick={() => { setActive(i); setHistOpen(false); }}
                      >
                        <span className={s.ht}>{c.msgs.find((m) => m.role === 'user')?.text ?? '新对话'}</span>
                        <span className={s.hd}>{fmtWhen(c.ts)}</span>
                      </div>
                    )).reverse()}
                    <button className={s.histClear} onClick={clearHist}>清空本课程全部记录</button>
                  </>
                )}
              </div>
            </div>
            <div className={s.chips}>
              <span className={s.chip}>{meta.name} · 判语可逐句回放</span>
            </div>
          </div>
        </div>

        <div className={s.courseBody}>
          <div>
            <div className={s.chat}>
              <div className={s.chatScroll} ref={scrollRef}>
                {msgs.map((m, mi) =>
                  m.role === 'user' ? (
                    <div key={mi} className={`${s.msg} ${s.user}`}>{m.text}</div>
                  ) : (
                    <div key={mi} className={`${s.msg} ${s.ai}`}>
                      <div className={s.aiTag}>
                        {m.quotes && m.quotes.length
                          ? m.mode === 'keyword'
                            ? '倪师判语 · 关键词结果'
                            : '倪师判语 · 语义检索'
                          : '课程导读'}
                      </div>
                      <div className={s.aiBody}>
                        {m.intro && <p className={s.aiIntro} dangerouslySetInnerHTML={{ __html: m.intro }} />}
                        {(m.quotes ?? []).map((g, gi) => (
                          <div key={gi} className={s.quoteGroup}>
                            <div className={s.qgTitle}>{g.title}</div>
                            {g.items.map((r) => {
                              const n = bases[mi] + (m.quotes ?? []).slice(0, gi).reduce((a, gg) => a + gg.items.length, 0) + g.items.indexOf(r) + 1;
                              return (
                                <div key={r.id} className={s.quote}>
                                  <span className={s.qt}>{r.quote}</span>
                                  <span className={s.src} onClick={() => openRef(n - 1)} title="点击展开引用">
                                    <span className={s.rn}>[{n}]</span> {bookMeta(r.book_id)?.short}{pad2(r.ep)} · {r.t_hms.slice(3)} ↗
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                        {m.foot && <p className={s.aiFoot}>{m.foot}</p>}
                      </div>
                    </div>
                  )
                )}
                {busy && (
                  <div className={`${s.msg} ${s.ai} ${s.typing}`}>
                    <div className={s.aiBody}>
                      在{scopeName}里翻判语
                      <span className={s.dots}><i /><i /><i /></span>
                    </div>
                  </div>
                )}
              </div>
              <div className={s.chatInput}>
                <div className={s.chipsRow}>
                  {meta.chips.map((c) => (
                    <button key={c} className={s.chipBtn} onClick={() => void ask(c)}>{c}</button>
                  ))}
                </div>
                <div className={s.inputRow}>
                  <div className={s.scopeSel}>
                    <button className={s.scopeBtn} onClick={(e) => { e.stopPropagation(); setScopeOpen((v) => !v); }}>
                      问答范围：{scopeName} ▾
                    </button>
                    <div className={`${s.scopeMenu} ${scopeOpen ? s.open : ''}`} onClick={(e) => e.stopPropagation()}>
                      {BOOKS.map((b) => (
                        <div
                          key={b.id}
                          className={`${s.scopeItem} ${scope === b.id ? 'on' : ''}`}
                          onClick={() => { setScope(b.id); setScopeOpen(false); }}
                        >
                          {b.name}
                        </div>
                      ))}
                      <div
                        className={`${s.scopeItem} ${scope === 'ALL' ? 'on' : ''}`}
                        onClick={() => { setScope('ALL'); setScopeOpen(false); }}
                      >
                        全库六部（跨部检索）
                      </div>
                    </div>
                  </div>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void ask(input); }}
                    placeholder="问点什么……如「太阳中风是什么道理」"
                    autoComplete="off"
                  />
                  <button className={`${s.btn} ${s.solid}`} disabled={busy} onClick={() => void ask(input)}>
                    问 倪 师
                  </button>
                </div>
              </div>
            </div>
            <p className={s.chatFoot}>
              当前回答模式：<b>{refs.length ? '语料检索' : '语料检索'}</b>——基于 19,294 条判语的语义检索（向量库 pgvector），
              引用可回放倪师原话的那一秒。回答仅供传统文化学习参考，不构成医疗建议。
            </p>
          </div>

          <aside className={s.outline}>
            <h3>{meta.name} · 大纲</h3>
            <div className={s.olList}>
              {outline === null ? (
                <div className={s.histEmpty}>加载中…</div>
              ) : outline.length === 0 ? (
                <div className={s.histEmpty}>大纲加载失败</div>
              ) : (
                outline.map((o) => (
                  <div key={o.h2} className={s.olItem} onClick={() => void ask(`${o.h2} 都讲了什么？`)}>
                    <span>{o.h2}</span>
                    <span className={s.n}>{o.n} 条</span>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      </div>

      {/* 引用侧滑面板 */}
      <aside className={`${s.refDrawer} ${ref ? s.open : ''}`}>
        <div className={s.refHead}>
          <span className={s.refBadge}>{ref ? `[${ref.no}] 引用出处` : '引用出处'}</span>
          <button className={s.refClose} onClick={() => setRef(null)}>✕</button>
        </div>
        {ref && (
          <div className={s.refBody}>
            <p className={s.refSrc}>{ref.src}</p>
            <h4 className={s.refTitle}>{ref.title}</h4>
            <blockquote className={s.refQuote}>{ref.quote}</blockquote>
            <a className={`${s.btn} ${s.solid} ${s.refPlay}`} href={ref.url} target="_blank" rel="noopener">
              ▶ 在 B 站回放该秒
            </a>
            <button
              className={s.refCopy}
              onClick={(e) => {
                const btn = e.currentTarget;
                navigator.clipboard?.writeText(ref.url).then(() => {
                  btn.textContent = '已复制 ✓';
                  setTimeout(() => { btn.textContent = '复制回放链接'; }, 1200);
                }).catch(() => {});
              }}
            >
              复制回放链接
            </button>
            <p className={s.refNote}>出处为字幕级判语，个别字或与原音有出入；以原视频为准。</p>
          </div>
        )}
      </aside>
    </div>
  );
}
