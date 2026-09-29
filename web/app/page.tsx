import Link from 'next/link';

const FEATURES = [
  {
    icon: '📘',
    title: 'Grounded in your course',
    body: 'Answers pull straight from your primers and readings, with citations you can trace.',
  },
  {
    icon: '🎙️',
    title: 'Knows your lectures',
    body: 'Ask about a class and get the key ideas from what was actually said.',
  },
  {
    icon: '✍️',
    title: 'Study, not guesswork',
    body: 'No made-up facts. If it is not in your materials, it says so.',
  },
];

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 680,
        margin: '0 auto',
        padding: '56px 20px 80px',
      }}
    >
      <section style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 56, lineHeight: 1, marginBottom: 20 }} aria-hidden>
          🎓
        </div>
        <h1
          style={{
            fontSize: 40,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            marginBottom: 14,
          }}
        >
          Study, grounded in
          <br />
          your course.
        </h1>
        <p
          style={{
            fontSize: 18,
            lineHeight: 1.5,
            color: 'var(--label-secondary)',
            maxWidth: 440,
            margin: '0 auto 30px',
          }}
        >
          Ask anything about your class. Answers come straight from your course primers and
          readings, with citations.
        </p>
        <Link href="/chat">
          <button className="btn btn--filled">Open chat</button>
        </Link>
      </section>

      <section
        style={{
          marginTop: 56,
          display: 'grid',
          gap: 12,
        }}
      >
        {FEATURES.map((f) => (
          <div
            key={f.title}
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'flex-start',
              background: 'var(--bg-elevated)',
              border: '0.5px solid var(--separator)',
              borderRadius: 'var(--radius-card)',
              padding: '16px 18px',
            }}
          >
            <div style={{ fontSize: 26, lineHeight: 1.2 }} aria-hidden>
              {f.icon}
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 3 }}>{f.title}</div>
              <div style={{ fontSize: 15, lineHeight: 1.45, color: 'var(--label-secondary)' }}>
                {f.body}
              </div>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
