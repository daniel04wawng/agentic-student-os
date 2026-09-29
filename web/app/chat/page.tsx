'use client';

import { useAuth } from '@clerk/nextjs';
import { useRef, useState } from 'react';

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? 'https://daniel04wawng--student-os-backend-serve.modal.run';

interface Source {
  type: string;
  title: string;
}
interface Msg {
  mine: boolean;
  text: string;
  sources?: Source[];
}

export default function ChatPage() {
  const { getToken } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  async function send() {
    const question = input.trim();
    if (!question || sending) return;
    setInput('');
    setMessages((m) => [...m, { mine: true, text: question }]);
    setSending(true);
    try {
      const token = await getToken().catch(() => null);
      const res = await fetch(`${BACKEND}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      setMessages((m) => [
        ...m,
        { mine: false, text: data.answer || 'No answer.', sources: data.sources },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { mine: false, text: "Couldn't reach the assistant. Try again in a moment." },
      ]);
    } finally {
      setSending(false);
      requestAnimationFrame(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
    }
  }

  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100dvh - 58px)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {messages.length === 0 && (
          <p style={{ color: '#6b7280', textAlign: 'center', marginTop: 40 }}>
            Ask about your course, e.g. &ldquo;Explain r &minus; g versus the debt ratio.&rdquo;
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: m.mine ? 'flex-end' : 'flex-start',
              margin: '8px 0',
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: '10px 14px',
                borderRadius: 14,
                background: m.mine ? '#111827' : '#f3f4f6',
                color: m.mine ? 'white' : '#111827',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
              }}
            >
              {m.text}
              {m.sources && m.sources.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
                  {m.sources.map((s, j) => (
                    <div key={j}>
                      {s.type === 'primer' ? '📘' : s.type === 'lecture' ? '🎙️' : '📄'} {s.title}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && <p style={{ color: '#9ca3af', paddingLeft: 8 }}>Thinking…</p>}
      </div>
      <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Ask about your course…"
          style={{
            flex: 1,
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid #d1d5db',
            fontSize: 16,
          }}
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          style={{
            padding: '0 20px',
            borderRadius: 10,
            border: 'none',
            background: '#111827',
            color: 'white',
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </main>
  );
}
