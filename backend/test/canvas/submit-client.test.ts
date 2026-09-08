import { describe, expect, it } from 'vitest';
import {
  DirectCanvasSubmitClient,
  UnconfiguredCanvasSubmitClient,
  createCanvasSubmitClient,
  type FetchLike,
} from '../../src/canvas/submit.js';

describe('DirectCanvasSubmitClient', () => {
  it('POSTs an online_url submission with the bearer token', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const fetchImpl: FetchLike = async (u, i) => {
      url = u;
      init = i;
      return new Response(JSON.stringify({ id: 987 }), { status: 200 });
    };
    const client = new DirectCanvasSubmitClient('https://x.instructure.com/', 'tok', fetchImpl);
    const res = await client.submit({
      canvasCourseId: '10',
      canvasAssignmentId: '20',
      artifactUri: 'https://docs.google.com/document/d/abc',
      text: '',
    });
    expect(res.canvasSubmissionId).toBe('987');
    expect(url).toBe('https://x.instructure.com/api/v1/courses/10/assignments/20/submissions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(init!.body as string);
    expect(body.submission).toMatchObject({ submission_type: 'online_url', url: 'https://docs.google.com/document/d/abc' });
  });

  it('uploads a file via the 3-step online_upload flow', async () => {
    const calls: string[] = [];
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    const fetchImpl: FetchLike = async (u) => {
      calls.push(u);
      if (u.endsWith('/submissions/self/files')) return json({ upload_url: 'https://files/up', upload_params: { k: 'v' } });
      if (u === 'https://files/up') return json({ id: 42 });
      if (u.endsWith('/submissions')) return json({ id: 'sub-9' });
      return new Response('', { status: 404 });
    };
    const client = new DirectCanvasSubmitClient('https://x', 't', fetchImpl);
    const res = await client.submitFile(
      { canvasCourseId: '1', canvasAssignmentId: '2', artifactUri: null, text: '' },
      { bytes: Buffer.from('%PDF-1.4'), filename: 'a.pdf', contentType: 'application/pdf' },
    );
    expect(res.canvasSubmissionId).toBe('sub-9');
    expect(calls[0]).toContain('/submissions/self/files'); // step 1: request slot
    expect(calls[1]).toBe('https://files/up'); // step 2: upload bytes
    expect(calls[2]).toContain('/assignments/2/submissions'); // step 3: submit online_upload
  });

  it('throws on a non-2xx submit', async () => {
    const client = new DirectCanvasSubmitClient('https://x', 't', async () => new Response('', { status: 401 }));
    await expect(
      client.submit({ canvasCourseId: '1', canvasAssignmentId: '2', artifactUri: null, text: 'hi' }),
    ).rejects.toThrow(/401/);
  });

  it('verifies only a submitted submission', async () => {
    const submitted = new DirectCanvasSubmitClient('https://x', 't', async () =>
      new Response(JSON.stringify({ id: 5, workflow_state: 'submitted' }), { status: 200 }),
    );
    expect(await submitted.getSubmission('1', '2')).toEqual({ id: '5' });

    const notYet = new DirectCanvasSubmitClient('https://x', 't', async () =>
      new Response(JSON.stringify({ id: 5, workflow_state: 'unsubmitted' }), { status: 200 }),
    );
    expect(await notYet.getSubmission('1', '2')).toBeNull();
  });
});

describe('createCanvasSubmitClient', () => {
  it('returns the unconfigured client without a token', () => {
    expect(createCanvasSubmitClient({})).toBeInstanceOf(UnconfiguredCanvasSubmitClient);
  });
  it('returns the direct client with base + token', () => {
    expect(createCanvasSubmitClient({ baseUrl: 'https://x', token: 't' })).toBeInstanceOf(DirectCanvasSubmitClient);
  });
});
