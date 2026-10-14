'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZiweiChart } from '@/lib/ziwei/types';
import s from './v2.module.css';

const PRESET_QUESTIONS = ['解读夫妻宫', '问财运', '看事业格局', '今年运势如何'];

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * V2 右侧 AI 对话栏（常驻，可折叠）：复用 /api/interpret SSE 对话接口，
 * 每轮提问扣 1 次 AI 解读次数，模型失败自动退还。
 */
export default function AiSidePanel({
  chart,
  collapsed,
  onCollapse,
}: {
  chart: ZiweiChart;
  collapsed: boolean;
  onCollapse: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // 命盘切换（重新起盘/打开新盘）时清空旧对话，避免旧解读被误认为新盘的分析
  useEffect(() => {
    setMessages([]);
    setLoading(false);
  }, [chart]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || loading) return;
      const userMsg: Msg = { role: 'user', content: text.trim() };
      const next = [...messages, userMsg];
      setMessages(next);
      setInput('');
      setLoading(true);
      try {
        const res = await fetch('/api/interpret', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chart, messages: next }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.message || '请求失败');
        }
        if (!res.body) throw new Error('无响应流');
        setMessages([...next, { role: 'assistant', content: '' }]);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let ai = '';
        let buffer = ''; // SSE 事件可能被 read() 边界截断，缓冲不完整的行
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // 最后一段可能不完整，留到下一轮
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              ai += parsed.delta?.text ?? '';
              setMessages((prev) => {
                const u = [...prev];
                u[u.length - 1] = { role: 'assistant', content: ai };
                return u;
              });
            } catch {
              /* 跳过不完整块 */
            }
          }
        }
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content:
              e instanceof Error && e.message !== 'Failed to fetch' && e.message !== '请求失败'
                ? e.message
                : '解读失败，请稍后重试。',
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [messages, loading, chart]
  );

  if (collapsed) return null;

  return (
    <section className={s.chatCol}>
      <div className={s.drHead}>
        <div>
          <div className={s.drTitle}>AI 解读</div>
          <div className={s.drSub}>
            当前命盘：{chart.birthInfo.name || '未命名'} · {chart.wuxingJuName}
          </div>
        </div>
        <div className={s.drTools}>
          <button type="button" className={s.drIcon} title="收起对话栏" onClick={onCollapse}>
            »
          </button>
        </div>
      </div>

      <div className={s.msgs} ref={scrollRef}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 12px', fontSize: 12, color: 'var(--zw2-muted)' }}>
            命盘已就绪，可直接提问
            <br />
            或从下方选择常见问题开始解读
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`${s.msg} ${m.role === 'user' ? s.msgUser : s.msgAi}`}>
            {m.content}
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role === 'user' && (
          <div className={`${s.msg} ${s.msgAi}`}>思考中…</div>
        )}
      </div>

      <div className={s.drQuick}>
        {PRESET_QUESTIONS.map((q) => (
          <span key={q} onClick={() => send(q)}>
            {q}
          </span>
        ))}
      </div>
      <div className={s.drInput}>
        <textarea
          placeholder="基于当前命盘继续提问…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <button type="button" className={s.drSend} title="发送" disabled={loading} onClick={() => send(input)}>
          ➤
        </button>
      </div>
      <div className={s.drNote}>AI 回答自动关联当前命盘；每次提问消耗 1 次 AI 解读次数，失败自动退还。</div>
    </section>
  );
}
