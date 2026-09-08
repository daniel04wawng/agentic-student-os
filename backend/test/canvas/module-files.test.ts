import { describe, expect, it } from 'vitest';
import { DirectCanvasClient, resolveCourseFiles, type FetchLike } from '../../src/canvas/client.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('resolveCourseFiles', () => {
  it('falls back to module items when /files is 403', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/files?')) return json({ error: 'forbidden' }, 403);
      if (url.includes('/modules?')) {
        return json([
          { id: 1, name: 'Week 1', items: [
            { id: 10, type: 'File', content_id: 858736, title: 'Case A.pdf' },
            { id: 11, type: 'Page', title: 'Intro' },
          ] },
        ]);
      }
      if (url.endsWith('/files/858736')) {
        return json({ id: 858736, display_name: 'Case A.pdf', url: 'https://dl/a', 'content-type': 'application/pdf' });
      }
      return json([], 404);
    };
    const client = new DirectCanvasClient({ baseUrl: 'https://c', token: 't', fetchImpl });
    const files = await resolveCourseFiles(client, 6768);
    expect(files).toHaveLength(1);
    expect(files[0]!.display_name).toBe('Case A.pdf');
  });

  it('uses /files directly when it is allowed', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/files?')) return json([{ id: 1, display_name: 'Open.pdf', url: 'u' }]);
      return json([], 500);
    };
    const client = new DirectCanvasClient({ baseUrl: 'https://c', token: 't', fetchImpl });
    const files = await resolveCourseFiles(client, 1);
    expect(files.map((f) => f.display_name)).toEqual(['Open.pdf']);
  });
});
