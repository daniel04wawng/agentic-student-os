/**
 * Deterministic parser for manual control commands. Natural-language phrasing is
 * matched by keyword rules (a model can enrich parsing later; the safety-critical
 * bits stay deterministic). Dangerous overrides are flagged for confirmation.
 */
export type ControlAction = 'pause' | 'resume' | 'defer' | 'set_policy' | 'unknown';

export interface ParsedCommand {
  action: ControlAction;
  scope: 'global' | 'course';
  courseName?: string;
  policy?: 'auto' | 'require_review';
  untilEvent?: string;
  dangerous: boolean;
}

export function parseCommand(input: string): ParsedCommand {
  const text = input.trim().toLowerCase();
  const courseMatch = /course\s+([a-z0-9._-]+)/.exec(text);
  const scope: 'global' | 'course' = courseMatch ? 'course' : 'global';
  const courseName = courseMatch?.[1];

  if (/^(resume|unpause|continue)/.test(text)) {
    return { action: 'resume', scope, courseName, dangerous: false };
  }
  if (/^(pause|stop|hold)/.test(text)) {
    return { action: 'pause', scope, courseName, dangerous: false };
  }
  if (/defer|wait until|hold until/.test(text)) {
    const until = /until\s+([a-z0-9._:-]+)/.exec(text)?.[1];
    return { action: 'defer', scope, courseName, untilEvent: until, dangerous: false };
  }
  if (/policy/.test(text)) {
    const auto = /\bauto/.test(text);
    return {
      action: 'set_policy',
      scope,
      courseName,
      policy: auto ? 'auto' : 'require_review',
      // Switching to auto-submit is dangerous: it removes the human review gate.
      dangerous: auto,
    };
  }
  return { action: 'unknown', scope, courseName, dangerous: false };
}
