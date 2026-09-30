'use client';

import { useEffect, useState } from 'react';

interface Block {
  heading?: string;
  text: string;
}
interface Chapter {
  title: string;
  topic: string;
  blocks: Block[];
}

// The primer text is stored as page-sized blobs. Re-flow into readable
// paragraphs (~3 sentences) so it reads like a book, not a wall of text.
function toParagraphs(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.?!”"])\s+(?=[A-Z“"$])/);
  const paras: string[] = [];
  let buf: string[] = [];
  for (const s of sentences) {
    if (!s) continue;
    buf.push(s);
    if (buf.length >= 3 || buf.join(' ').length > 340) {
      paras.push(buf.join(' '));
      buf = [];
    }
  }
  if (buf.length) paras.push(buf.join(' '));
  return paras;
}

const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", ui-serif, serif';

function Paragraph({ text, dropCap }: { text: string; dropCap: boolean }) {
  // Textbook call-out boxes ("box 1 ...") get a styled card.
  const box = /^box\s+(\d+)\s+/i.exec(text);
  if (box) {
    return (
      <aside
        style={{
          margin: '20px 0',
          padding: '14px 18px',
          borderRadius: 12,
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          borderLeft: '3px solid var(--accent)',
        }}
      >
        <div
          style={{
            fontFamily: 'system-ui, sans-serif',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: 6,
          }}
        >
          Box {box[1]}
        </div>
        <div style={{ fontSize: 16.5, lineHeight: 1.7 }}>{text.slice(box[0].length)}</div>
      </aside>
    );
  }
  if (dropCap) {
    return (
      <p style={{ margin: '0 0 18px' }}>
        <span
          style={{
            float: 'left',
            fontSize: 56,
            lineHeight: 0.82,
            fontWeight: 700,
            padding: '4px 10px 0 0',
            color: 'var(--accent)',
            fontFamily: SERIF,
          }}
        >
          {text.charAt(0)}
        </span>
        {text.slice(1)}
      </p>
    );
  }
  return <p style={{ margin: '0 0 18px' }}>{text}</p>;
}

export function Textbook({ backend }: { backend: string }) {
  const [open, setOpen] = useState(false);
  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || chapters) return;
    setLoading(true);
    fetch(`${backend}/textbook`)
      .then((r) => r.json())
      .then((d) => setChapters(Array.isArray(d.chapters) ? d.chapters : []))
      .catch(() => setChapters([]))
      .finally(() => setLoading(false));
  }, [open, chapters, backend]);

  const current = chapters?.[active];
  let firstPara = true;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open textbook"
        style={{
          position: 'fixed',
          top: 'calc(max(12px, env(safe-area-inset-top, 0px)) + 9px)',
          right: 16,
          zIndex: 20,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          height: 34,
          padding: '0 14px',
          borderRadius: 999,
          border: '0.5px solid var(--separator)',
          background: 'var(--bg-elevated)',
          color: 'var(--label)',
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1,
          cursor: 'pointer',
          boxShadow: '0 1px 4px rgba(0,0,0,0.10)',
        }}
      >
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
          📖
        </span>
        <span style={{ lineHeight: 1 }}>Textbook</span>
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 30,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(760px, 96vw)',
              height: '100%',
              background: 'var(--bg)',
              borderLeft: '0.5px solid var(--separator)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '-8px 0 40px rgba(0,0,0,0.3)',
            }}
          >
            <header
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 20px',
                paddingTop: 'max(14px, env(safe-area-inset-top, 0px))',
                borderBottom: '0.5px solid var(--separator)',
              }}
            >
              <strong style={{ fontSize: 17 }}>📖 Course primers</strong>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--accent)',
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Done
              </button>
            </header>

            {chapters && chapters.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  overflowX: 'auto',
                  padding: '12px 16px',
                  borderBottom: '0.5px solid var(--separator)',
                  WebkitOverflowScrolling: 'touch',
                }}
              >
                {chapters.map((c, i) => (
                  <button
                    key={c.title + i}
                    onClick={() => setActive(i)}
                    style={{
                      flex: '0 0 auto',
                      padding: '7px 14px',
                      borderRadius: 999,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13.5,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      background:
                        i === active
                          ? 'var(--accent)'
                          : 'color-mix(in srgb, var(--label-secondary) 12%, transparent)',
                      color: i === active ? '#fff' : 'var(--label)',
                    }}
                  >
                    {c.topic}
                  </button>
                ))}
              </div>
            )}

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '32px 20px calc(56px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              {loading && (
                <p style={{ color: 'var(--label-secondary)', textAlign: 'center' }}>
                  Loading the primers…
                </p>
              )}
              {!loading && chapters && chapters.length === 0 && (
                <p style={{ color: 'var(--label-secondary)', textAlign: 'center' }}>
                  No primers loaded yet.
                </p>
              )}
              {current && (
                <article
                  style={{
                    maxWidth: 640,
                    margin: '0 auto',
                    fontFamily: SERIF,
                    fontSize: 18.5,
                    lineHeight: 1.78,
                    color: 'var(--label)',
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'system-ui, sans-serif',
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--accent)',
                      marginBottom: 6,
                    }}
                  >
                    {current.title}
                  </div>
                  <h2
                    style={{
                      fontFamily: SERIF,
                      fontSize: 32,
                      fontWeight: 700,
                      lineHeight: 1.15,
                      letterSpacing: '-0.01em',
                      margin: '0 0 10px',
                    }}
                  >
                    {current.topic}
                  </h2>
                  <div
                    style={{
                      height: 3,
                      width: 52,
                      background: 'var(--accent)',
                      borderRadius: 2,
                      margin: '0 0 28px',
                    }}
                  />
                  {current.blocks.map((block, bi) => (
                    <section key={bi}>
                      {block.heading && (
                        <h3
                          style={{
                            fontFamily: SERIF,
                            fontSize: 21,
                            fontWeight: 700,
                            lineHeight: 1.3,
                            margin: '26px 0 12px',
                          }}
                        >
                          {block.heading}
                        </h3>
                      )}
                      {toParagraphs(block.text).map((para, pi) => {
                        const useDropCap = firstPara && !/^box\s+\d+/i.test(para);
                        if (firstPara) firstPara = false;
                        return <Paragraph key={pi} text={para} dropCap={useDropCap} />;
                      })}
                    </section>
                  ))}
                </article>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
