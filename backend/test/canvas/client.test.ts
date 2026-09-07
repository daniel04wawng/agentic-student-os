import { describe, expect, it } from 'vitest';
import {
  CanvasError,
  DirectCanvasClient,
  parseNextLink,
  type FetchLike,
} from '../../src/canvas/client.js';

function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.link) headers.link = init.link;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe('parseNextLink', () => {
  it('extracts the rel="next" url', () => {
    const header = '<https://c/api/v1/courses?page=1>; rel="current", <https://c/api/v1/courses?page=2>; rel="next"';
    expect(parseNextLink(header)).toBe('https://c/api/v1/courses?page=2');
  });
  it('returns null when there is no next', () => {
    expect(parseNextLink('<https://c/x>; rel="current"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe('DirectCanvasClient', () => {
  it('sends a Bearer token and Accept header', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init;
      return jsonResponse({ id: 1, name: 'Me' });
    };
    const client = new DirectCanvasClient({ baseUrl: 'https://c/', token: 'tok', fetchImpl });
    await client.diagnose();
    expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('follows Link-header pagination', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('page=2')) return jsonResponse([{ id: 2, name: 'B' }]);
      return jsonResponse([{ id: 1, name: 'A' }], {
        link: '<https://c/api/v1/courses?page=2>; rel="next"',
      });
    };
    const client = new DirectCanvasClient({ baseUrl: 'https://c', token: 't', fetchImpl });
    const courses = await client.listActiveCourses();
    expect(courses.map((c) => c.id)).toEqual([1, 2]);
  });

  it('throws CanvasError with the status on a non-2xx', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ errors: 'nope' }, { status: 403 });
    const client = new DirectCanvasClient({ baseUrl: 'https://c', token: 't', fetchImpl });
    await expect(client.listActiveCourses()).rejects.toBeInstanceOf(CanvasError);
    await expect(client.listActiveCourses()).rejects.toMatchObject({ status: 403 });
  });

  it('reads modules and announcements from the course endpoints', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes('/modules')) return jsonResponse([{ id: 1, name: 'Intro' }]);
      return jsonResponse([{ id: 9, title: 'Welcome' }]); // announcements
    };
    const client = new DirectCanvasClient({ baseUrl: 'https://c', token: 't', fetchImpl });
    const modules = await client.listModules(5);
    const anns = await client.listAnnouncements(5);
    expect(modules[0]!.name).toBe('Intro');
    expect(anns[0]!.title).toBe('Welcome');
    expect(urls.some((u) => u.includes('/courses/5/modules'))).toBe(true);
    expect(urls.some((u) => u.includes('only_announcements=true'))).toBe(true);
  });

  it('diagnose reports ok on 200 and not-ok on auth failure', async () => {
    const ok = new DirectCanvasClient({
      baseUrl: 'https://c',
      token: 't',
      fetchImpl: async () => jsonResponse({ id: 7, name: 'Stu' }),
    });
    expect(await ok.diagnose()).toMatchObject({ ok: true, user: { id: 7 } });

    const bad = new DirectCanvasClient({
      baseUrl: 'https://c',
      token: 'bad',
      fetchImpl: async () => jsonResponse({ errors: 'unauthorized' }, { status: 401 }),
    });
    const d = await bad.diagnose();
    expect(d.ok).toBe(false);
    expect(d.error).toContain('401');
  });
});
