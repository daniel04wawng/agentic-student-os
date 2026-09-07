import type { CanvasAssignment, CanvasCourse, CanvasUser } from './types.js';

/** Injectable fetch so the client is testable without real network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CanvasDiagnosis {
  ok: boolean;
  user?: CanvasUser;
  error?: string;
}

/**
 * Read-only Canvas client. Intentionally has NO write/submit methods (PR 4 is
 * read-only). Implementations: DirectCanvasClient now; a Composio-backed client
 * later behind the same interface.
 */
export interface CanvasClient {
  diagnose(): Promise<CanvasDiagnosis>;
  listActiveCourses(): Promise<CanvasCourse[]>;
  getCourse(courseId: number): Promise<CanvasCourse>;
  listAssignments(courseId: number): Promise<CanvasAssignment[]>;
}

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CanvasError';
  }
}

/** Parse the `rel="next"` URL from a Canvas Link header, if present. */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1] ?? null;
  }
  return null;
}

export interface DirectCanvasOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}

/** Direct Canvas REST API implementation (Bearer token). */
export class DirectCanvasClient implements CanvasClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: DirectCanvasOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  private async get(pathOrUrl: string): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new CanvasError(`Canvas GET ${url} -> ${res.status}`, res.status);
    return res;
  }

  /** Follow Canvas Link-header pagination, accumulating array pages. */
  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${this.baseUrl}${path}`;
    while (next) {
      const res: Response = await this.get(next);
      out.push(...((await res.json()) as T[]));
      next = parseNextLink(res.headers.get('link'));
    }
    return out;
  }

  async diagnose(): Promise<CanvasDiagnosis> {
    try {
      const res = await this.get('/api/v1/users/self');
      const user = (await res.json()) as CanvasUser;
      return { ok: true, user };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  listActiveCourses(): Promise<CanvasCourse[]> {
    return this.getAll<CanvasCourse>(
      '/api/v1/courses?enrollment_state=active&include[]=term&per_page=100',
    );
  }

  async getCourse(courseId: number): Promise<CanvasCourse> {
    const res = await this.get(`/api/v1/courses/${courseId}?include[]=term`);
    return (await res.json()) as CanvasCourse;
  }

  listAssignments(courseId: number): Promise<CanvasAssignment[]> {
    return this.getAll<CanvasAssignment>(`/api/v1/courses/${courseId}/assignments?per_page=100`);
  }
}

/**
 * Factory: choose a Canvas client from config. Only the direct API is
 * implemented in PR 4; the Composio path is reserved and reports clearly when
 * selected but unavailable.
 */
export function createCanvasClient(opts: {
  baseUrl?: string;
  token?: string;
  fetchImpl?: FetchLike;
}): CanvasClient {
  if (!opts.baseUrl || !opts.token) {
    throw new CanvasError('Canvas is not configured (missing CANVAS_BASE_URL/CANVAS_API_TOKEN)', 0);
  }
  return new DirectCanvasClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    fetchImpl: opts.fetchImpl,
  });
}
