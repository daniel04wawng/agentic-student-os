import type {
  CanvasAssignment,
  CanvasCalendarEvent,
  CanvasCourse,
  CanvasDiscussion,
  CanvasFile,
  CanvasModule,
  CanvasUser,
} from './types.js';

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

/**
 * Extends the core read client with ancillary course-content reads used by
 * onboarding. Kept separate so callers that only need the core objects are not
 * forced to implement these.
 */
export interface CanvasContentClient extends CanvasClient {
  listModules(courseId: number): Promise<CanvasModule[]>;
  listDiscussions(courseId: number): Promise<CanvasDiscussion[]>;
  listAnnouncements(courseId: number): Promise<CanvasDiscussion[]>;
  /** Calendar events (class meetings) for a course in a date window (YYYY-MM-DD). */
  listCalendarEvents(courseId: number, startDate: string, endDate: string): Promise<CanvasCalendarEvent[]>;
  /** Files posted in a course (readings/slides/cases the prof provides). */
  listFiles(courseId: number): Promise<CanvasFile[]>;
  /** Download a file's bytes (ephemeral; caller extracts text then discards). */
  downloadFile(url: string): Promise<Buffer>;
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
export class DirectCanvasClient implements CanvasContentClient {
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
    const res = await this.get(
      `/api/v1/courses/${courseId}?include[]=term&include[]=syllabus_body`,
    );
    return (await res.json()) as CanvasCourse;
  }

  listAssignments(courseId: number): Promise<CanvasAssignment[]> {
    return this.getAll<CanvasAssignment>(`/api/v1/courses/${courseId}/assignments?per_page=100`);
  }

  listModules(courseId: number): Promise<CanvasModule[]> {
    return this.getAll<CanvasModule>(`/api/v1/courses/${courseId}/modules?per_page=100`);
  }

  listDiscussions(courseId: number): Promise<CanvasDiscussion[]> {
    return this.getAll<CanvasDiscussion>(
      `/api/v1/courses/${courseId}/discussion_topics?per_page=100`,
    );
  }

  listAnnouncements(courseId: number): Promise<CanvasDiscussion[]> {
    return this.getAll<CanvasDiscussion>(
      `/api/v1/courses/${courseId}/discussion_topics?only_announcements=true&per_page=100`,
    );
  }

  listCalendarEvents(courseId: number, startDate: string, endDate: string): Promise<CanvasCalendarEvent[]> {
    const q = `type=event&context_codes[]=course_${courseId}&start_date=${startDate}&end_date=${endDate}&per_page=100`;
    return this.getAll<CanvasCalendarEvent>(`/api/v1/calendar_events?${q}`);
  }

  listFiles(courseId: number): Promise<CanvasFile[]> {
    return this.getAll<CanvasFile>(`/api/v1/courses/${courseId}/files?per_page=100`);
  }

  async downloadFile(url: string): Promise<Buffer> {
    // Canvas file URLs are pre-authenticated (verifier); the bearer is harmless.
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new CanvasError(`Canvas download ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
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
