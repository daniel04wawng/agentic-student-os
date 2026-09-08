/**
 * Outlook (Microsoft Graph) client abstraction. Real client uses managed OAuth
 * (Composio or Graph API); a fake is used in tests. Sending/creating anything is
 * gated by approval elsewhere.
 */
export interface OutlookMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export interface OutlookEvent {
  id: string;
  subject: string;
  startsAt: string;
  endsAt?: string;
}

export interface OutlookClient {
  listMessages(): Promise<OutlookMessage[]>;
  listEvents(): Promise<OutlookEvent[]>;
  createDraftReply(messageId: string, body: string): Promise<{ draftId: string }>;
}

export class FakeOutlookClient implements OutlookClient {
  drafts: { messageId: string; body: string }[] = [];

  constructor(
    private readonly messages: OutlookMessage[] = [],
    private readonly events: OutlookEvent[] = [],
  ) {}

  async listMessages(): Promise<OutlookMessage[]> {
    return this.messages;
  }
  async listEvents(): Promise<OutlookEvent[]> {
    return this.events;
  }
  async createDraftReply(messageId: string, body: string): Promise<{ draftId: string }> {
    this.drafts.push({ messageId, body });
    return { draftId: `draft-${this.drafts.length}` };
  }
}

export class OutlookNotConfiguredError extends Error {
  constructor() {
    super('Outlook is not connected. Complete managed OAuth first.');
    this.name = 'OutlookNotConfiguredError';
  }
}

export class UnconfiguredOutlookClient implements OutlookClient {
  async listMessages(): Promise<OutlookMessage[]> {
    throw new OutlookNotConfiguredError();
  }
  async listEvents(): Promise<OutlookEvent[]> {
    throw new OutlookNotConfiguredError();
  }
  async createDraftReply(): Promise<{ draftId: string }> {
    throw new OutlookNotConfiguredError();
  }
}
