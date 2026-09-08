import type { OutlookMessage } from '../outlook/client.js';

export type AdminKind = 'email' | 'scheduling' | 'form' | 'payment' | 'other';

export interface Classification {
  kind: AdminKind;
  actionable: boolean;
}

/** Deterministic message classification (keyword rules, no LLM). */
export function classifyMessage(message: OutlookMessage): Classification {
  const text = `${message.subject} ${message.body}`.toLowerCase();
  let kind: AdminKind = 'email';
  if (/\b(schedul|meeting|appointment|calendar|reschedul)/.test(text)) kind = 'scheduling';
  else if (/\b(invoice|payment|tuition|bill|balance due|pay )/.test(text)) kind = 'payment';
  else if (/\b(form|survey|questionnaire|sign up|register)/.test(text)) kind = 'form';

  const actionable =
    kind !== 'email' || /\b(please|action required|respond|reply|due|deadline|confirm)/.test(text);
  return { kind, actionable };
}
