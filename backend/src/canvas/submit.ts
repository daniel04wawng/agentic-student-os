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
