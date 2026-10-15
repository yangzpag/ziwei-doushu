'use client';

/**
 * 中医知识库 · 首页（设计稿 viewHome 移植）
 * 全库语义搜索 + 六部课程卡片。命中项点击 → 课程页自动追问该条文。
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
  const [hits, setHits] = useState<Entry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/zhongyi/books')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  const runSearch = useCallback(async (value: string) => {
    if (!value.trim()) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch('/api/zhongyi/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: value }),
      });
      const d = res.ok ? await res.json() : null;
      setHits(d?.hits ?? []);
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const onInput = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) {
      setHits(null);
      return;
    }
    timer.current = setTimeout(() => void runSearch(v), 300);
  };

  // 按部归组展示（保持设计稿的 sp-group 形式）
  const grouped = (hits ?? []).reduce<{ book: string; items: Entry[] }[]>((acc, r) => {
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
            每一句判语都精确到秒，点击出处直接回放倪师原视频的那一秒。先选一门课进入问答，或直接搜索全库。
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
              placeholder="搜索全库：症状、方剂、药名、条文……如「桂枝汤」「失眠」「足三里」"
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
            {searching && hits === null ? (
              <div className={s.spEmpty}>检索中…</div>
            ) : hits && hits.length === 0 ? (
              <div className={s.spEmpty}>全库没有接近的内容，换个说法试试（少打几个字更容易命中）</div>
            ) : (
              grouped.map((g) => (
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
              ))
            )}
          </div>
        )}
        <p className={s.searchHint}>语义检索——意思相近就能搜到（如「出汗怕风」「桂枝汤」都能找到太阳中风的判语）。</p>

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
