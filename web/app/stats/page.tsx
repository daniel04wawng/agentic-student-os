'use client';

import { useEffect, useState } from 'react';

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? 'https://daniel04wawng--student-os-backend-serve.modal.run';

interface Stats {
  totalViews: number;
  uniqueVisitors: number;
  viewsLast7Days: number;
  byDay: { day: string; views: number }[];
  topPaths: { path: string; views: number }[];
  topReferrers: { referrer: string; views: number }[];
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 140,
        background: 'var(--bg-elevated)',
        border: '0.5px solid var(--separator)',
        borderRadius: 'var(--radius-card)',
        padding: '16px 18px',
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em' }}>
        {value.toLocaleString()}
      </div>
      <div style={{ fontSize: 13, color: 'var(--label-secondary)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`${BACKEND}/stats`)
      .then((r) => r.json())
      .then(setStats)
      .catch(() => setError(true));
  }, []);

  const maxDay = Math.max(1, ...(stats?.byDay.map((d) => d.views) ?? [1]));

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px 80px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 20 }}>
        Traffic
      </h1>

      {error && <p style={{ color: 'var(--label-secondary)' }}>Couldn&rsquo;t load stats.</p>}
      {!stats && !error && <p style={{ color: 'var(--label-secondary)' }}>Loading…</p>}

      {stats && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            <Stat label="Total views" value={stats.totalViews} />
            <Stat label="Unique visitors" value={stats.uniqueVisitors} />
            <Stat label="Views (7 days)" value={stats.viewsLast7Days} />
          </div>

          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Last 14 days</h2>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
              {stats.byDay.length === 0 && (
                <span style={{ color: 'var(--label-secondary)', fontSize: 14 }}>No views yet.</span>
              )}
              {stats.byDay.map((d) => (
                <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
                  <div
                    title={`${d.day}: ${d.views}`}
                    style={{
                      height: `${(d.views / maxDay) * 96}px`,
                      background: 'var(--accent)',
                      borderRadius: '4px 4px 0 0',
                      minHeight: 2,
                    }}
                  />
                  <div style={{ fontSize: 9, color: 'var(--label-tertiary)', marginTop: 4 }}>
                    {d.day.slice(5)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24 }}>
            <List title="Top pages" rows={stats.topPaths.map((p) => [p.path, p.views])} />
            <List title="Top sources" rows={stats.topReferrers.map((r) => [r.referrer, r.views])} />
          </div>
        </>
      )}
    </main>
  );
}

function List({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <section>
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{title}</h2>
      {rows.length === 0 && (
        <p style={{ color: 'var(--label-secondary)', fontSize: 14 }}>Nothing yet.</p>
      )}
      {rows.map(([k, v]) => (
        <div
          key={k}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 0',
            borderBottom: '0.5px solid var(--separator)',
            fontSize: 14,
          }}
        >
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={k}
          >
            {k}
          </span>
          <span style={{ color: 'var(--label-secondary)', flex: '0 0 auto' }}>{v}</span>
        </div>
      ))}
    </section>
  );
}
