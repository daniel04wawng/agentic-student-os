import type { Metadata } from 'next';
import Link from 'next/link';
import { ClerkProvider, Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { Analytics } from './Analytics';
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
        <Analytics />
        <nav className="nav">
          <Link href="/" className="nav__brand">
            <span aria-hidden>🎓</span>
            <span>Student OS</span>
          </Link>
          {clerkEnabled && (
            <div className="nav__actions">
              <Show when="signed-out">
                <SignInButton>
                  <button className="btn btn--plain">Sign in</button>
                </SignInButton>
                <SignUpButton>
                  <button className="btn btn--tinted">Sign up</button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </div>
          )}
        </nav>
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
