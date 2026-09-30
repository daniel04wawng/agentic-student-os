'use client';

import { useEffect, useState } from 'react';

interface Chapter {
  title: string;
  text: string;
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

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open textbook"
        style={{
          position: 'fixed',
          top: 'calc(max(12px, env(safe-area-inset-top, 0px)) + 8px)',
          right: 16,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 999,
          border: '0.5px solid var(--separator)',
          background: 'var(--bg-elevated)',
          color: 'var(--label)',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        }}
      >
        <span aria-hidden>📖</span> Textbook
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 30,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(460px, 94vw)',
              height: '100%',
              background: 'var(--bg)',
              borderLeft: '0.5px solid var(--separator)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '-8px 0 30px rgba(0,0,0,0.25)',
            }}
          >
            <header
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
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
                  gap: 6,
                  overflowX: 'auto',
                  padding: '10px 12px',
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
                      padding: '5px 12px',
                      borderRadius: 999,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      background:
                        i === active
                          ? 'var(--accent)'
                          : 'color-mix(in srgb, var(--label-secondary) 12%, transparent)',
                      color: i === active ? '#fff' : 'var(--label)',
                    }}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
            )}

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '18px 20px calc(24px + env(safe-area-inset-bottom, 0px))',
                fontSize: 16,
                lineHeight: 1.6,
                color: 'var(--label)',
              }}
            >
              {loading && <p style={{ color: 'var(--label-secondary)' }}>Loading the primers…</p>}
              {!loading && chapters && chapters.length === 0 && (
                <p style={{ color: 'var(--label-secondary)' }}>No primers loaded yet.</p>
              )}
              {current && (
                <article>
                  <h2
                    style={{
                      fontSize: 24,
                      fontWeight: 700,
                      letterSpacing: '-0.01em',
                      marginBottom: 14,
                    }}
                  >
                    {current.title}
                  </h2>
                  {current.text.split(/\n\n+/).map((para, i) => (
                    <p key={i} style={{ margin: '0 0 14px' }}>
                      {para.trim()}
                    </p>
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
