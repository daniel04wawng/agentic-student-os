'use client';

import { useEffect, useRef, useState } from 'react';

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? 'https://daniel04wawng--student-os-backend-serve.modal.run';

interface Source {
  type: string;
  title: string;
  snippet?: string;
}
interface Labeled extends Source {
  label: string; // P1, M2, L1 ...
}
interface Msg {
  mine: boolean;
  text: string;
  sources?: Labeled[];
  streaming?: boolean;
  step?: string;
}

const SOURCE_ICON: Record<string, string> = { primer: '📘', lecture: '🎙️', material: '📄' };
const TYPE_PREFIX: Record<string, string> = { primer: 'P', material: 'M', lecture: 'L' };

// Rebuild the [P1]/[M2]/[L1] labels the backend used: it appends primers, then
// materials, then lectures, numbering each type from 1 in that order. So the
// nth source of a type is <PREFIX><n>. This lets us match inline [labels] in the
// answer text to their source.
function labelSources(sources?: Source[]): Labeled[] {
  if (!sources) return [];
  const counts: Record<string, number> = {};
  return sources.map((s) => {
    const prefix = TYPE_PREFIX[s.type] ?? 'S';
    counts[prefix] = (counts[prefix] ?? 0) + 1;
    return {
      type: s.type,
      title: (s.title ?? '').trim(),
      snippet: s.snippet,
      label: `${prefix}${counts[prefix]}`,
    };
  });
}

const CITE_RE = /\[([PML]\d+)\]/g;

function AssistantBubble({ text, sources }: { text: string; sources: Labeled[] }) {
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  const [active, setActive] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const refFor = useRef<Record<string, HTMLDivElement | null>>({});

  // Only show references that are actually cited in the text (keeps it tidy);
  // fall back to all sources if the model didn't inline any labels.
  const citedLabels = Array.from(new Set([...text.matchAll(CITE_RE)].map((m) => m[1]!)));
  const refs = (citedLabels.length ? citedLabels.map((l) => byLabel.get(l)).filter(Boolean) : sources) as Labeled[];

  function jumpTo(label: string) {
    setActive(label);
    setExpanded((e) => (e === label ? e : label)); // reveal the passage
    refFor.current[label]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    window.setTimeout(() => setActive((a) => (a === label ? null : a)), 1600);
  }

  // Split the answer into text + clickable citation chips.
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CITE_RE.lastIndex = 0;
  let k = 0;
  while ((m = CITE_RE.exec(text))) {
    const label = m[1]!;
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (byLabel.has(label)) {
      parts.push(
        <button
          key={`c${k++}`}
          onClick={() => jumpTo(label)}
          title={byLabel.get(label)!.title}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            verticalAlign: 'baseline',
            border: 'none',
            cursor: 'pointer',
            background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
            color: 'var(--accent)',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            padding: '2px 5px',
            borderRadius: 6,
            margin: '0 1px',
            transform: 'translateY(-1px)',
          }}
        >
          {label}
        </button>,
      );
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
    k++;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <div
      style={{
        maxWidth: '82%',
        padding: '9px 14px',
        borderRadius: 'var(--radius-bubble)',
        borderBottomLeftRadius: 6,
        background: 'var(--bubble-them)',
        color: 'var(--bubble-them-text)',
        fontSize: 16,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {parts}
      {refs.length > 0 && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: '0.5px solid var(--separator)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {refs.map((s) => {
            const isOpen = expanded === s.label;
            return (
              <div
                key={s.label}
                ref={(el) => {
                  refFor.current[s.label] = el;
                }}
                style={{
                  background:
                    active === s.label
                      ? 'color-mix(in srgb, var(--accent) 18%, transparent)'
                      : 'transparent',
                  borderRadius: 8,
                  transition: 'background 0.3s ease',
                }}
              >
                <button
                  onClick={() => setExpanded((e) => (e === s.label ? null : s.label))}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    fontSize: 12.5,
                    color: 'var(--label-secondary)',
                    background: 'transparent',
                    border: 'none',
                    cursor: s.snippet ? 'pointer' : 'default',
                    padding: '3px 6px',
                    textAlign: 'left',
                    font: 'inherit',
                  }}
                >
                  <span style={{ flex: '0 0 auto', fontWeight: 700, color: 'var(--accent)', fontSize: 11 }}>
                    {s.label}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {SOURCE_ICON[s.type] ?? '📄'} {s.title}
                  </span>
                  {s.snippet && (
                    <span style={{ flex: '0 0 auto', color: 'var(--label-tertiary)', fontSize: 11 }}>
                      {isOpen ? '▲' : '▼'}
                    </span>
                  )}
                </button>
                {isOpen && s.snippet && (
                  <div
                    style={{
                      margin: '2px 6px 6px',
                      padding: '8px 10px',
                      borderLeft: '2px solid var(--accent)',
                      background: 'color-mix(in srgb, var(--label-secondary) 8%, transparent)',
                      borderRadius: 6,
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      color: 'var(--label)',
                    }}
                  >
                    {s.snippet}
                    {s.snippet.length >= 490 ? '…' : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Kick the backend awake as soon as the page opens, so it is warming while the
  // user reads and types (scale-to-zero + a large model = slow cold first answer).
  useEffect(() => {
    fetch(`${BACKEND}/health`, { method: 'GET' }).catch(() => {});
  }, []);

  function scrollToEnd() {
    requestAnimationFrame(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
  }

  // Update the last (assistant) message in place.
  function patchLast(patch: (m: Msg) => Msg) {
    setMessages((mm) => {
      if (mm.length === 0) return mm;
      const copy = mm.slice();
      copy[copy.length - 1] = patch(copy[copy.length - 1]!);
      return copy;
    });
  }

  // Steps shown while the answer is being prepared, so the wait reads as work
  // (retrieval then generation) rather than a dead spinner.
  const THINKING_STEPS = [
    'Searching your course materials',
    'Reading the relevant passages',
    'Writing your answer',
    'Almost there',
  ];

  async function send() {
    const question = input.trim();
    if (!question || sending) return;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setMessages((mm) => [
      ...mm,
      { mine: true, text: question },
      { mine: false, text: '', streaming: true, step: THINKING_STEPS[0] },
    ]);
    setSending(true);
    scrollToEnd();

    let stepIdx = 0;
    const stepTimer = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, THINKING_STEPS.length - 1);
      patchLast((m) => (m.text ? m : { ...m, step: THINKING_STEPS[stepIdx] }));
    }, 4000);

    try {
      const res = await fetch(`${BACKEND}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      patchLast((m) => ({
        ...m,
        text: data.answer || 'No answer.',
        sources: labelSources(data.sources),
        step: undefined,
      }));
    } catch {
      patchLast((m) => ({
        ...m,
        text: "Couldn't reach the assistant. Try again in a moment.",
        step: undefined,
      }));
    } finally {
      clearInterval(stepTimer);
      patchLast((m) => ({ ...m, streaming: false, step: undefined }));
      setSending(false);
      scrollToEnd();
    }
  }

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100dvh - 57px)',
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

          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: msg.mine ? 'flex-end' : 'flex-start',
                margin: '4px 0',
              }}
            >
              {msg.mine ? (
                <div
                  style={{
                    maxWidth: '82%',
                    padding: '9px 14px',
                    borderRadius: 'var(--radius-bubble)',
                    borderBottomRightRadius: 6,
                    background: 'var(--accent)',
                    color: '#fff',
                    fontSize: 16,
                    lineHeight: 1.4,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {msg.text}
                </div>
              ) : msg.text === '' ? (
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
                  {msg.step ?? 'Thinking'}
                </div>
              ) : (
                <AssistantBubble text={msg.text} sources={msg.sources ?? []} />
              )}
            </div>
          ))}

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
