import type { GoogleDoc, GoogleDocsClient } from './client.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ComposioError extends Error {
  constructor(
    message: string,
    readonly action: string,
  ) {
    super(message);
    this.name = 'ComposioError';
  }
}

/**
 * Thin executor over Composio's v3 tool-execution API. Any part of the system
 * can run an action (Docs, Drive, Calendar, Gmail) through one call; typed
 * adapters like {@link ComposioGoogleDocsClient} sit on top. Actions run as the
 * connected account for `userId`.
 */
export class ComposioClient {
  constructor(
    private readonly apiKey: string,
    private readonly userId: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
    private readonly baseUrl = 'https://backend.composio.dev',
  ) {}

  async execute<T = unknown>(action: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v3/tools/execute/${action}`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user_id: this.userId, arguments: args }),
    });
    if (!res.ok) throw new ComposioError(`${action} -> HTTP ${res.status}`, action);
    const body = (await res.json()) as { successful?: boolean; error?: unknown; data?: T };
    if (body.successful === false) {
      throw new ComposioError(`${action} failed: ${JSON.stringify(body.error)}`, action);
    }
    return body.data as T;
  }
}

// Minimal shapes of the Docs/Drive responses we consume.
interface DocsElement {
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
}
interface DocsResponseData {
  revisionId?: string;
  body?: { content?: DocsElement[] };
}

/** Walk a Google Docs document body into plain text. */
function extractDocText(rd: DocsResponseData | undefined): string {
  let out = '';
  for (const el of rd?.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      if (pe.textRun?.content) out += pe.textRun.content;
    }
  }
  return out;
}

/**
 * GoogleDocsClient backed by Composio. Verified live against a real connected
 * account: create, read (text + revision), update (markdown), and export to
 * PDF (Drive download with mime_type=application/pdf, then fetch the returned
 * file url) all work.
 */
export class ComposioGoogleDocsClient implements GoogleDocsClient {
  constructor(
    private readonly composio: ComposioClient,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

  private uri(id: string): string {
    return `https://docs.google.com/document/d/${id}/edit`;
  }

  async createDoc(title: string, content: string): Promise<GoogleDoc> {
    const d = await this.composio.execute<{ document_id: string; response_data?: DocsResponseData }>(
      'GOOGLEDOCS_CREATE_DOCUMENT',
      { title, text: content },
    );
    const id = d.document_id;
    const revisionId = d.response_data?.revisionId ?? (await this.getRevision(id));
    return { id, uri: this.uri(id), revisionId };
  }

  async updateDoc(id: string, content: string): Promise<GoogleDoc> {
    await this.composio.execute('GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN', {
      document_id: id,
      new_markdown_text: content,
    });
    return { id, uri: this.uri(id), revisionId: await this.getRevision(id) };
  }

  async getRevision(id: string): Promise<string> {
    const d = await this.composio.execute<{ response_data?: DocsResponseData }>(
      'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
      { id },
    );
    return d.response_data?.revisionId ?? '';
  }

  async getContent(id: string): Promise<string> {
    const d = await this.composio.execute<{ response_data?: DocsResponseData }>(
      'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
      { id },
    );
    return extractDocText(d.response_data);
  }

  async exportPdf(id: string): Promise<Buffer> {
    const d = await this.composio.execute<{ downloaded_file_content?: { s3url?: string } }>(
      'GOOGLEDRIVE_DOWNLOAD_FILE',
      { file_id: id, mime_type: 'application/pdf' },
    );
    const url = d.downloaded_file_content?.s3url;
    if (!url) throw new ComposioError('export returned no file url', 'GOOGLEDRIVE_DOWNLOAD_FILE');
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new ComposioError(`pdf fetch HTTP ${res.status}`, 'GOOGLEDRIVE_DOWNLOAD_FILE');
    return Buffer.from(await res.arrayBuffer());
  }
}
