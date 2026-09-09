import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { UnconfiguredGoogleDocsClient } from '../../src/google/client.js';
import { ComposioClient, ComposioError, ComposioGoogleDocsClient, type FetchLike } from '../../src/google/composio.js';
import { createGoogleDocsClient } from '../../src/google/factory.js';

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ successful: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake Composio + S3 endpoints, capturing the executed actions. */
function fakeFetch(calls: { action: string; args: unknown }[]): FetchLike {
  return async (url, init) => {
    if (url.startsWith('https://s3/')) return new Response(Buffer.from('%PDF-1.4 fake'), { status: 200 });
    const action = url.split('/execute/')[1] ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as { arguments: unknown };
    calls.push({ action, args: body.arguments });
    if (action === 'GOOGLEDOCS_CREATE_DOCUMENT') return ok({ document_id: 'doc1', response_data: { revisionId: 'r1' } });
    if (action === 'GOOGLEDOCS_GET_DOCUMENT_BY_ID')
      return ok({ response_data: { revisionId: 'r2', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello body' } }] } }] } } });
    if (action === 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN') return ok({});
    if (action === 'GOOGLEDRIVE_DOWNLOAD_FILE') return ok({ downloaded_file_content: { s3url: 'https://s3/test.pdf' } });
    return new Response(JSON.stringify({ successful: false, error: 'unknown action' }), { status: 200 });
  };
}

describe('ComposioGoogleDocsClient', () => {
  it('creates, reads text, updates, and exports PDF', async () => {
    const calls: { action: string; args: unknown }[] = [];
    const fetchImpl = fakeFetch(calls);
    const client = new ComposioGoogleDocsClient(new ComposioClient('k', 'daniel', fetchImpl), fetchImpl);

    const doc = await client.createDoc('T', 'body');
    expect(doc).toMatchObject({ id: 'doc1', revisionId: 'r1' });
    expect(doc.uri).toContain('doc1');
    expect(calls[0]).toMatchObject({ action: 'GOOGLEDOCS_CREATE_DOCUMENT', args: { title: 'T', text: 'body' } });

    expect(await client.getContent('doc1')).toBe('Hello body');
    expect(await client.getRevision('doc1')).toBe('r2');

    const updated = await client.updateDoc('doc1', '# New');
    expect(updated.revisionId).toBe('r2');

    const pdf = await client.exportPdf('doc1');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('throws ComposioError when an action fails', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ successful: false, error: 'boom' }), { status: 200 });
    const client = new ComposioClient('k', 'daniel', fetchImpl);
    await expect(client.execute('X', {})).rejects.toBeInstanceOf(ComposioError);
  });
});

describe('createGoogleDocsClient', () => {
  const base = { INNGEST_DEV: '0', AUTO_SUBMIT: '0' };
  it('returns the Composio client when a key is set, else Unconfigured', () => {
    expect(createGoogleDocsClient(loadConfig({ ...base, COMPOSIO_API_KEY: 'ak_x' } as NodeJS.ProcessEnv))).toBeInstanceOf(
      ComposioGoogleDocsClient,
    );
    expect(createGoogleDocsClient(loadConfig({ ...base } as NodeJS.ProcessEnv))).toBeInstanceOf(
      UnconfiguredGoogleDocsClient,
    );
  });
});
