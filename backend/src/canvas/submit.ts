/**
 * Canvas SUBMISSION (write) client. Separate from the read client; needs a
 * Canvas token with submission scope. A fake is used in tests; the unconfigured
 * client fails clearly until a write token exists.
 */
export interface SubmitArgs {
  canvasCourseId: string;
  canvasAssignmentId: string;
  artifactUri: string | null;
  text: string;
}

export interface CanvasSubmitClient {
  submit(args: SubmitArgs): Promise<{ canvasSubmissionId: string }>;
  /** Read back the submission to VERIFY the write actually landed. */
  getSubmission(canvasCourseId: string, canvasAssignmentId: string): Promise<{ id: string } | null>;
}

/** In-memory fake. `failVerify` simulates a write that does not verify. */
export class FakeCanvasSubmitClient implements CanvasSubmitClient {
  submitCount = 0;
  private readonly store = new Map<string, string>();

  constructor(private readonly opts: { failVerify?: boolean } = {}) {}

  async submit(args: SubmitArgs): Promise<{ canvasSubmissionId: string }> {
    this.submitCount += 1;
    const id = `sub-${this.submitCount}`;
    if (!this.opts.failVerify) {
      this.store.set(`${args.canvasCourseId}:${args.canvasAssignmentId}`, id);
    }
    return { canvasSubmissionId: id };
  }

  async getSubmission(courseId: string, assignmentId: string): Promise<{ id: string } | null> {
    const id = this.store.get(`${courseId}:${assignmentId}`);
    return id ? { id } : null;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Real Canvas submission client (Bearer token). Submits the artifact as an
 * online_url when a link is available, else as text, and verifies by reading
 * the student's submission back. This is the last-mile adapter over the PR 23
 * submission state machine — all gating/idempotency/verification lives there.
 */
export class DirectCanvasSubmitClient implements CanvasSubmitClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async submit(args: SubmitArgs): Promise<{ canvasSubmissionId: string }> {
    const submission = args.artifactUri
      ? { submission_type: 'online_url', url: args.artifactUri }
      : { submission_type: 'online_text_entry', body: args.text };
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/courses/${args.canvasCourseId}/assignments/${args.canvasAssignmentId}/submissions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission }),
      },
    );
    if (!res.ok) throw new Error(`Canvas submit ${res.status}`);
    const body = (await res.json()) as { id?: number | string };
    return { canvasSubmissionId: String(body.id ?? '') };
  }

  async getSubmission(courseId: string, assignmentId: string): Promise<{ id: string } | null> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self`,
      { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: number | string; workflow_state?: string };
    // Only treat it as verified when Canvas reports it actually submitted.
    if (body.workflow_state && body.workflow_state !== 'unsubmitted' && body.id != null) {
      return { id: String(body.id) };
    }
    return null;
  }
}

export class CanvasSubmitNotConfiguredError extends Error {
  constructor() {
    super('Canvas submission is not configured (needs a write-scoped token).');
    this.name = 'CanvasSubmitNotConfiguredError';
  }
}

export class UnconfiguredCanvasSubmitClient implements CanvasSubmitClient {
  async submit(): Promise<{ canvasSubmissionId: string }> {
    throw new CanvasSubmitNotConfiguredError();
  }
  async getSubmission(): Promise<{ id: string } | null> {
    throw new CanvasSubmitNotConfiguredError();
  }
}

/** Build a submit client from config: real when a base URL + token exist. */
export function createCanvasSubmitClient(opts: {
  baseUrl?: string;
  token?: string;
}): CanvasSubmitClient {
  if (opts.baseUrl && opts.token) {
    return new DirectCanvasSubmitClient(opts.baseUrl, opts.token);
  }
  return new UnconfiguredCanvasSubmitClient();
}
