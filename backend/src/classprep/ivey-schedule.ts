import type { SqlClient } from '../db/client.js';
import { splitCoursepack } from '../materials/split.js';
import { matchScheduleToCases, setCaseSchedule, type ScheduleEntry } from './schedule.js';

/**
 * Ivey delivers the per-session plan (which case each class date is assigned)
 * through an LTI "Session Summary" tool, not the Canvas API. We launch it the way
 * a browser does - a Canvas sessionless launch, then the signed OAuth form POST to
 * the Ivey tool - and parse the rendered page. This is best-effort: if the tool is
 * unreachable or its markup changes, prep falls back to order-based matching.
 */

const MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/').replace(/&#x2B;/g, '+')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Parse an Ivey "Session Summary" page into { date, caseTitle } entries. Only
 * sessions the professor has published appear; a session with no assigned case
 * (a theory/intro/exam day) yields caseTitle null and is skipped by the caller.
 */
export function parseSessionSummary(html: string): ScheduleEntry[] {
  const joined = decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '),
  ).replace(/\s+/g, ' ');
  const re = /([A-Z][a-z]+) (\d{1,2}), (\d{4})\s+Details \(Session (\d+)\)/g;
  const marks: { month: string; day: number; year: number; idx: number }[] = [];
  for (let m = re.exec(joined); m; m = re.exec(joined)) {
    marks.push({ month: m[1]!, day: Number(m[2]), year: Number(m[3]), idx: m.index });
  }
  const entries: ScheduleEntry[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const seg = joined.slice(marks[i]!.idx, marks[i + 1]?.idx ?? joined.length);
    // A session can carry several "Case:" tokens: file-link artifacts plus the
    // real assignment. Take the first that is a real title, trimmed at its
    // product code / study-question tail (Ivey prints "Title (HBS 702049) Q1...").
    let caseTitle: string | null = null;
    for (const piece of seg.split(/\bCase:\s*/).slice(1)) {
      // A file-link artifact BEGINS with the anchor tag; the check must be
      // anchored, since a real title's trailing text can also mention a link.
      if (/^<|^a id=/i.test(piece.trim())) continue;
      const stop = piece.search(
        /\s(?:HBS|Ivey)\b|\((?:HBS|Ivey|9B|W\d)|\?|\s\d+\.\s|\b(?:Watch|Read|Prepare|Study Questions):/i,
      );
      const c = (stop >= 0 ? piece.slice(0, stop) : piece).replace(/[.,;\s]+$/, '').trim();
      if (c.length >= 4) {
        caseTitle = c;
        break;
      }
    }
    const month = MONTHS[marks[i]!.month];
    if (month === undefined) continue;
    const date = `${marks[i]!.year}-${String(month + 1).padStart(2, '0')}-${String(marks[i]!.day).padStart(2, '0')}`;
    entries.push({ date, caseTitle: caseTitle ?? '' });
  }
  return entries.filter((e) => e.caseTitle);
}

interface CanvasAuth {
  baseUrl: string;
  token: string;
}

type Fetch = typeof fetch;

/** Accumulate Set-Cookie headers into a jar (best-effort, name=value only). */
function absorbCookies(res: Response, jar: Record<string, string>): void {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]!] = m[2]!;
  }
}

const cookieHeader = (jar: Record<string, string>): string =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** Find a course's LTI tool id by its navigation label (e.g. "Session Summary"). */
export async function findToolIdByLabel(
  auth: CanvasAuth,
  canvasCourseId: number,
  label: string,
  fetchImpl: Fetch = fetch,
): Promise<number | null> {
  const res = await fetchImpl(`${auth.baseUrl}/api/v1/courses/${canvasCourseId}/tabs?per_page=100`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  if (!res.ok) return null;
  const tabs = (await res.json()) as { label?: string; url?: string }[];
  const tab = Array.isArray(tabs) ? tabs.find((t) => t.label?.toLowerCase() === label.toLowerCase()) : undefined;
  const id = tab?.url?.match(/[?&]id=(\d+)/)?.[1];
  return id ? Number(id) : null;
}

/**
 * Launch an Ivey LTI tool the way a browser does and return its rendered HTML:
 * a Canvas sessionless launch, following redirects to the auto-submitting OAuth
 * form, then POSTing that signed form to the Ivey provider. Returns null on any
 * failure (unreachable host, unexpected markup) so callers stay best-effort.
 */
export async function launchLtiTool(
  auth: CanvasAuth,
  canvasCourseId: number,
  toolId: number,
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  try {
    const j = (await (
      await fetchImpl(
        `${auth.baseUrl}/api/v1/courses/${canvasCourseId}/external_tools/sessionless_launch?id=${toolId}`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
      )
    ).json()) as { url?: string };
    if (!j.url) return null;

    // Follow the Canvas launch to the auto-submitting LTI form.
    let url = j.url;
    const jar: Record<string, string> = {};
    let body = '';
    for (let hop = 0; hop < 8; hop += 1) {
      const res = await fetchImpl(url, {
        headers: cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {},
        redirect: 'manual',
      });
      absorbCookies(res, jar);
      const loc = res.headers.get('location');
      if (loc) {
        url = new URL(loc, url).href;
        continue;
      }
      body = await res.text();
      break;
    }
    const action = body.match(/<form[^>]*action="([^"]+)"/i)?.[1];
    if (!action) return null;
    const fields: Record<string, string> = {};
    for (const m of body.matchAll(/<input[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"/gi)) {
      fields[decodeEntities(m[1]!)] = decodeEntities(m[2]!);
    }

    // POST the signed form to the Ivey provider, following any redirects.
    const ijar: Record<string, string> = {};
    let res = await fetchImpl(decodeEntities(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
    absorbCookies(res, ijar);
    for (let loc = res.headers.get('location'), hop = 0; loc && hop < 8; hop += 1) {
      const u = new URL(loc, decodeEntities(action)).href;
      res = await fetchImpl(u, { headers: { Cookie: cookieHeader(ijar) }, redirect: 'manual' });
      absorbCookies(res, ijar);
      loc = res.headers.get('location');
    }
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Refresh a course's exact date->case schedule from its Ivey Session Summary
 * tool. Best-effort and idempotent: launches the tool, parses published
 * sessions, matches each to a case in the course's coursepack, and writes the
 * date->case-index map. A no-op (returns 0) when the tool, coursepack, or any
 * confident match is missing. Never throws.
 */
export async function syncIveyCaseSchedule(
  db: SqlClient,
  auth: CanvasAuth,
  canvasCourseId: number,
  courseId: string,
  fetchImpl: Fetch = fetch,
): Promise<number> {
  try {
    const toolId = await findToolIdByLabel(auth, canvasCourseId, 'Session Summary', fetchImpl);
    if (!toolId) return 0;
    const html = await launchLtiTool(auth, canvasCourseId, toolId, fetchImpl);
    if (!html) return 0;
    const entries = parseSessionSummary(html);
    if (entries.length === 0) return 0;

    const cp = await db.query<{ text: string }>(
      `SELECT text FROM materials WHERE course_id = $1 AND kind = 'case'
       ORDER BY length(text) DESC LIMIT 1`,
      [courseId],
    );
    if (cp.rows.length === 0) return 0;
    const cases = splitCoursepack(cp.rows[0]!.text);
    if (cases.length < 2) return 0;

    const map = matchScheduleToCases(cases, entries);
    if (Object.keys(map).length === 0) return 0;
    await setCaseSchedule(db, courseId, map);
    return Object.keys(map).length;
  } catch {
    return 0;
  }
}
