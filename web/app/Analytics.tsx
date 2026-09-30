'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? 'https://daniel04wawng--student-os-backend-serve.modal.run';

function visitorId(): string {
  try {
    let v = localStorage.getItem('sos_vid');
    if (!v) {
      v = (crypto.randomUUID?.() ?? String(Math.random())).slice(0, 32);
      localStorage.setItem('sos_vid', v);
    }
    return v;
  } catch {
    return 'anon';
  }
}

/** Fire a privacy-light page-view beacon on each navigation. */
export function Analytics() {
  const pathname = usePathname();
  useEffect(() => {
    const body = JSON.stringify({
      path: pathname || '/',
      referrer: document.referrer || '',
      visitor: visitorId(),
    });
    fetch(`${BACKEND}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }, [pathname]);
  return null;
}
