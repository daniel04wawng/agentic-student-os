'use client';

import { useEffect, useRef, useState } from 'react';

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

const SOURCE_ICON: Record<string, string> = { primer: '📘', lecture: '🎙️', material: '📄' };

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Kick the backend awake as soon as the page opens, so it is warming while the
  // user reads and types. Scale-to-zero + a large model means a cold first
  // answer is slow; this overlaps the wait.
  useEffect(() => {
    fetch(`${BACKEND}/health`, { method: 'GET' }).catch(() => {});
  }, []);

  // Elapsed-time counter drives the honest "still working" copy while sending.
  useEffect(() => {
    if (!sending) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [sending]);

  function scrollToEnd() {
    requestAnimationFrame(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
  }

  async function send() {
    const question = input.trim();
    if (!question || sending) return;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setMessages((m) => [...m, { mine: true, text: question }]);
    setSending(true);
    scrollToEnd();
    try {
      const res = await fetch(`${BACKEND}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      scrollToEnd();
    }
  }

  const waiting =
    elapsed < 6
      ? 'Thinking…'
      : elapsed < 25
        ? 'Reading your course materials…'
        : `Waking the study model — the first answer can take up to a minute. (${elapsed}s)`;

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100dvh - 57px)', // minus nav bar
        background: 'var(--bg)',
      }}
    >
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '16px 16px 8px' }}>
          {messages.length === 0 && !sending && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                color: 'var(--label-secondary)',
                padding: '72px 24px',
              }}
            >
              <div style={{ fontSize: 46, marginBottom: 14 }} aria-hidden>
                💬
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--label)', marginBottom: 6 }}>
                Ask about your classes
              </div>
              <div style={{ fontSize: 15, lineHeight: 1.45, maxWidth: 320 }}>
                e.g. &ldquo;Explain r &minus; g versus the debt ratio&rdquo; or &ldquo;Summarize the
                case for tomorrow.&rdquo;
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: m.mine ? 'flex-end' : 'flex-start',
                margin: '4px 0',
              }}
            >
              <div
                style={{
                  maxWidth: '82%',
                  padding: '9px 14px',
                  borderRadius: 'var(--radius-bubble)',
                  background: m.mine ? 'var(--accent)' : 'var(--bubble-them)',
                  color: m.mine ? '#fff' : 'var(--bubble-them-text)',
                  fontSize: 16,
                  lineHeight: 1.4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  borderBottomRightRadius: m.mine ? 6 : 'var(--radius-bubble)',
                  borderBottomLeftRadius: m.mine ? 'var(--radius-bubble)' : 6,
                }}
              >
                {m.text}
                {m.sources && m.sources.length > 0 && (
                  <div
                    style={{
                      marginTop: 8,
                      paddingTop: 8,
                      borderTop: '0.5px solid var(--separator)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                    }}
                  >
                    {m.sources.map((s, j) => (
                      <span
                        key={j}
                        style={{
                          fontSize: 12,
                          color: 'var(--label-secondary)',
                          background: 'color-mix(in srgb, var(--label-secondary) 12%, transparent)',
                          borderRadius: 8,
                          padding: '3px 8px',
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {SOURCE_ICON[s.type] ?? '📄'} {s.title}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {sending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '4px 0' }}>
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-bubble)',
                  borderBottomLeftRadius: 6,
                  background: 'var(--bubble-them)',
                  color: 'var(--label-secondary)',
                  fontSize: 15,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span className="dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                {waiting}
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          borderTop: '0.5px solid var(--separator)',
          background: 'var(--nav-blur)',
          backdropFilter: 'saturate(180%) blur(20px)',
          WebkitBackdropFilter: 'saturate(180%) blur(20px)',
          padding: '10px 12px calc(10px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div
          style={{
            maxWidth: 720,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
          }}
        >
          <textarea
            ref={taRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask about your classes…"
            style={{
              flex: 1,
              resize: 'none',
              padding: '10px 14px',
              borderRadius: 20,
              border: '0.5px solid var(--separator)',
              background: 'var(--bg-elevated)',
              color: 'var(--label)',
              fontSize: 16,
              lineHeight: 1.35,
              fontFamily: 'inherit',
              maxHeight: 120,
              outline: 'none',
            }}
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            aria-label="Send"
            style={{
              flex: '0 0 auto',
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: 'none',
              background: input.trim() && !sending ? 'var(--accent)' : 'var(--label-tertiary)',
              color: '#fff',
              cursor: input.trim() && !sending ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s ease',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 19V5M12 5l-6 6M12 5l6 6"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </main>
  );
}
