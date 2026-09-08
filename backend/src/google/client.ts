import { randomUUID } from 'node:crypto';

/**
 * Google Docs client abstraction (Drive/Docs/Sheets/Slides land behind the same
 * shape). Creating/updating a doc returns a remote revision id so the artifact
 * registry can track the exact remote version. Real implementation goes through
 * Composio or the Google API and needs OAuth; a fake is used in tests.
 */
export interface GoogleDoc {
  id: string;
  uri: string;
  revisionId: string;
}

export interface GoogleDocsClient {
  createDoc(title: string, content: string): Promise<GoogleDoc>;
  updateDoc(id: string, content: string): Promise<GoogleDoc>;
  getRevision(id: string): Promise<string>;
}

/** In-memory fake for tests: a monotonically increasing revision per doc. */
export class FakeGoogleDocsClient implements GoogleDocsClient {
  private readonly docs = new Map<string, { content: string; revision: number }>();

  async createDoc(_title: string, content: string): Promise<GoogleDoc> {
    const id = randomUUID();
    this.docs.set(id, { content, revision: 1 });
    return this.doc(id);
  }

  async updateDoc(id: string, content: string): Promise<GoogleDoc> {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`doc not found: ${id}`);
    doc.content = content;
    doc.revision += 1;
    return this.doc(id);
  }

  async getRevision(id: string): Promise<string> {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`doc not found: ${id}`);
    return String(doc.revision);
  }

  private doc(id: string): GoogleDoc {
    return {
      id,
      uri: `https://docs.google.com/document/d/${id}`,
      revisionId: String(this.docs.get(id)!.revision),
    };
  }
}

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super('Google is not connected. Complete OAuth (Composio or direct) first.');
    this.name = 'GoogleNotConfiguredError';
  }
}

/**
 * Placeholder for the real client. Wiring it needs a connected Google account
 * (OAuth token via Composio or the Google API). Until then it fails clearly.
 */
export class UnconfiguredGoogleDocsClient implements GoogleDocsClient {
  async createDoc(): Promise<GoogleDoc> {
    throw new GoogleNotConfiguredError();
  }
  async updateDoc(): Promise<GoogleDoc> {
    throw new GoogleNotConfiguredError();
  }
  async getRevision(): Promise<string> {
    throw new GoogleNotConfiguredError();
  }
}
