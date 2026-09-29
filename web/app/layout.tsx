import type { Metadata } from 'next';
import { ClerkProvider, Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'Student OS',
  description: 'Your classes, prepped for you.',
};

// Clerk turns on automatically once the publishable key is present. Until then
// the site works as a public chat, so it can ship without waiting on keys.
const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <strong style={{ fontSize: 18 }}>🎓 Student OS</strong>
          {clerkEnabled && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Show when="signed-out">
                <SignInButton />
                <SignUpButton />
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </div>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  if (clerkEnabled) {
    return (
      <ClerkProvider>
        <Shell>{children}</Shell>
      </ClerkProvider>
    );
  }
  return <Shell>{children}</Shell>;
}
