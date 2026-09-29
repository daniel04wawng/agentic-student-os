import { Show, SignInButton } from '@clerk/nextjs';
import Link from 'next/link';

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: '80px 24px',
        textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ fontSize: 40, marginBottom: 12 }}>Study, grounded in your course.</h1>
      <p style={{ fontSize: 18, color: '#4b5563', marginBottom: 32 }}>
        Ask anything about your class. Answers come straight from your course primers and
        readings, with citations.
      </p>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button
            style={{
              fontSize: 16,
              padding: '12px 28px',
              borderRadius: 10,
              border: 'none',
              background: '#111827',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            Sign in to start
          </button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <Link href="/chat">
          <button
            style={{
              fontSize: 16,
              padding: '12px 28px',
              borderRadius: 10,
              border: 'none',
              background: '#111827',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            Open chat
          </button>
        </Link>
      </Show>
    </main>
  );
}
