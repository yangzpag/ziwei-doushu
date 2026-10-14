'use client';

/**
 * 中医知识库 · 首页（设计稿 viewHome 移植）
 * 全库检索直接返回知识卡片（vk 流水线产物：摘要 + 整理文本 + 视频出处）。
 * 无卡片命中时降级展示判语原文。命中项点击 → 课程页自动追问该条文。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import TopBar from '@/components/v2/TopBar';
import s from './zhongyi.module.css';
import { BOOKS } from '@/lib/corpus/books';

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

interface KnowledgeCard {
  id: string;
  courseId: string;
  courseName: string;
  chapter: string;
  title: string;
  summary: string;
  body: string;
  keywords: string[];
  tStartHms: string;
  tEndHms: string | null;
  url: string;
  quality: string;
  completeness: string;
  genMode: string;
  evidenceCount: number;
}

interface BooksResp {
  books: { id: string; name: string; short: string; entries: number; eps: number }[];
  stats: { total: number; books: number; hours: number };
}

/** 搜索词高亮（与设计稿一致：≥2 字的词加粗） */
function highlight(text: string, q: string) {
  const terms = q.split(/[\s,，]+/).filter((t) => t.length >= 2);
  if (!terms.length) return text;
  const re = new RegExp(
    terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'gi'
  );
  const parts = text.split(re);
  const marks = text.match(re);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {marks && i < marks.length ? <b style={{ color: 'var(--zw2-gold-deep, #6E5320)' }}>{marks[i]}</b> : null}
        </span>
      ))}
    </>
  );
}

function srcLabel(r: Entry, short: string) {
  const mm = r.t_hms.slice(3);
  return `${short}${String(r.ep).padStart(2, '0')} · ${mm}`;
}

export default function KbHome() {
  const router = useRouter();
  const [data, setData] = useState<BooksResp | null>(null);
  const [q, setQ] = useState('');
  const [cards, setCards] = useState<KnowledgeCard[] | null>(null);
  const [foot, setFoot] = useState('');
  const [fallbackHits, setFallbackHits] = useState<Entry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/zhongyi/books')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  const runSearch = useCallback(async (value: string) => {
    if (!value.trim()) {
      setCards(null);
      setFallbackHits(null);
      setFoot('');
      return;
    }
    setSearching(true);
    setFailed(false);
    try {
      const res = await fetch('/api/zhongyi/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: value }),
      });
      if (!res.ok) {
        setFailed(true);
        setCards([]);
        return;
      }
      const d = await res.json();
      const list: KnowledgeCard[] = d?.cards ?? [];
      setCards(list);
      setFoot(d?.foot ?? '');
      setExpanded(new Set());
      // 无卡片命中 → 降级展示判语原文（词表覆盖更宽的兜底）
      if (list.length === 0) {
        try {
          const r2 = await fetch('/api/zhongyi/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: value }),
          });
          const d2 = r2.ok ? await r2.json() : null;
          setFallbackHits(d2?.hits ?? []);
        } catch {
          setFallbackHits([]);
        }
      } else {
        setFallbackHits(null);
      }
    } catch {
      setFailed(true);
      setCards([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const onInput = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) {
      setCards(null);
      setFallbackHits(null);
      setFoot('');
      return;
    }
    timer.current = setTimeout(() => void runSearch(v), 300);
  };

  const toggleBody = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 无卡片时的判语兜底（按部归组，保持原设计）
  const grouped = (fallbackHits ?? []).reduce<{ book: string; items: Entry[] }[]>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && last.book === r.book_id) last.items.push(r);
    else acc.push({ book: r.book_id, items: [r] });
    return acc;
  }, []);

  const total = data?.stats.total ?? 19294;

  return (
    <div className={s.page}>
      <TopBar active="tcm" />
      <div className="wrap">
        <div className={s.kbHead}>
          <p className={s.kbEyebrow}>TCM KNOWLEDGE BASE</p>
          <h1>
            中医知识库
            <small>倪海厦《人纪》 · {total.toLocaleString()} 条判语 · 117 集 · 178 小时</small>
          </h1>
          <p className={s.kbSub}>
            检索直接返回整理好的知识段落，带视频出处——先读摘要判断要不要看，点回放直接跳到那一秒。
          </p>
        </div>

        <div className={s.searchbar}>
          <div className={`${s.searchBox} ${q ? s.has : ''}`}>
            <svg className={s.sIco} width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 11l3.2 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              value={q}
              onChange={(e) => onInput(e.target.value)}
              placeholder="提问或搜索：症状、方剂、药名……如「湿疹」「半夏」「咳嗽有痰」"
              autoComplete="off"
            />
            {q && (
              <button className={s.sClear} title="清空" onClick={() => onInput('')}>
                ✕
              </button>
            )}
          </div>
        </div>

        {q.trim() && (
          <div className={s.searchPanel}>
            {searching && cards === null ? (
              <div className={s.spEmpty}>检索中…</div>
            ) : failed ? (
              <div className={s.spEmpty}>
                检索失败，请稍后重试
                <button className={s.cardMore} style={{ display: 'block', margin: '10px auto 0' }} onClick={() => void runSearch(q)}>
                  重试
                </button>
              </div>
            ) : cards && cards.length > 0 ? (
              <>
                {cards.map((c) => (
                  <div key={c.id} className={s.cardItem}>
                    <div className={s.cardTop}>
                      <span className={s.cardTitle}>{highlight(c.title, q)}</span>
                      <span className={s.cardMeta}>
                        {c.courseName} · {c.chapter} · {c.tStartHms}
                        {c.tEndHms ? `–${c.tEndHms}` : ''}
                      </span>
                      {c.url && (
                        <a className={s.cardGo} href={c.url} target="_blank" rel="noreferrer">
                          ▶ 回放那一秒
                        </a>
                      )}
                    </div>
                    <p className={s.cardSummary}>{highlight(c.summary, q)}</p>
                    <div className={s.cardKw}>
                      {c.keywords.slice(0, 6).map((k) => (
                        <span key={k} className={s.kwChip}>
                          {k}
                        </span>
                      ))}
                      <span className={s.cardMeta}>依据 {c.evidenceCount} 条字幕</span>
                    </div>
                    <button className={s.cardMore} onClick={() => toggleBody(c.id)}>
                      {expanded.has(c.id) ? '收起整理文本 ▲' : '展开整理文本 ▼'}
                    </button>
                    {expanded.has(c.id) && <div className={s.cardBody}>{c.body}</div>}
                  </div>
                ))}
                <div className={s.spEmpty} style={{ padding: '10px 26px' }}>{foot}</div>
              </>
            ) : fallbackHits && fallbackHits.length > 0 ? (
              <>
                <div className={s.spEmpty} style={{ padding: '12px 26px' }}>
                  没有命中的知识卡片，以下为判语原文命中：
                </div>
                {grouped.map((g) => (
                  <div key={g.book}>
                    <div className={s.spGroup}>{BOOKS.find((b) => b.id === g.book)?.name ?? g.book}</div>
                    {g.items.map((r) => (
                      <div
                        key={r.id}
                        className={s.spItem}
                        onClick={() => router.push(`/zhongyi/${r.book_id}?ask=${encodeURIComponent(r.h2 + ' 都讲了什么？')}`)}
                      >
                        <span className={s.t}>{r.h2}</span>
                        <span className={s.q}>{highlight(r.quote, q)}</span>
                        <span className={s.go}>▶ 回放 {srcLabel(r, BOOKS.find((b) => b.id === r.book_id)?.short ?? '')}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            ) : cards && cards.length === 0 ? (
              <div className={s.spEmpty}>没有命中的内容，换个说法试试（少打几个字更容易命中）</div>
            ) : null}
          </div>
        )}
        <p className={s.searchHint}>
          知识卡片由字幕/摘录整理而成，摘要每个要点都能回溯到原字幕；课程内容为讲者观点，仅供学习参考。
        </p>

        <div className={s.courses}>
          {BOOKS.map((b) => {
            const stat = data?.books.find((x) => x.id === b.id);
            return (
              <button key={b.id} className={s.course} onClick={() => router.push(`/zhongyi/${b.id}`)}>
                <span className={s.cTop}>
                  <span className={s.cNo}>{b.no}</span>
                  <span className={s.cName}>{b.name}</span>
                </span>
                <span className={s.cDesc}>{b.desc}</span>
                <span className={s.cStats}>
                  <span className={s.chip}>{stat ? `${stat.eps} 集 · ${stat.entries.toLocaleString()} 条判语` : '加载中…'}</span>
                  <span className={`${s.chip} g`}>可逐句回放</span>
                </span>
                <span className={s.cGo}>进入问答 →</span>
              </button>
            );
          })}
        </div>
        <p className={s.kbNote}>
          语料来源：nihai-renji-corpus（<b>CC BY-NC-SA 4.0，仅限非商业用途</b>）；原课程内容版权归倪海厦先生及其权利继承人所有。学习研究请以原视频为准。
        </p>
      </div>
    </div>
  );
}
