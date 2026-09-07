/**
 * Push delivery abstraction. Delivery is best-effort and sits ON TOP of the
 * persistent notification record; a failing sender must never lose the item.
 * A real APNs/web-push sender (needs provider credentials) implements this
 * later; the Noop sender is the safe default.
 */
export interface PushTarget {
  token: string;
  platform: string;
}

export interface PushMessage {
  title: string;
  body: string | null;
}

export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<void>;
}

/** Default sender: no-op success. Swap for a real APNs sender when configured. */
export class NoopPushSender implements PushSender {
  async send(): Promise<void> {
    // intentionally does nothing
  }
}
