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
