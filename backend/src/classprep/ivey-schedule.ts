import type { SqlClient } from '../db/client.js';
import { ingestFileBytes } from '../materials/service.js';
import { splitCoursepack } from '../materials/split.js';
import { matchScheduleToCases, setCaseSchedule, setSessionPlans, type ScheduleEntry } from './schedule.js';

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
  return parseSessionPlans(html)
    .filter((p) => p.caseTitle)
    .map((p) => ({ date: p.date, caseTitle: p.caseTitle! }));
}

/** The professor's published plan for one class meeting. */
export interface SessionPlan {
  date: string; // YYYY-MM-DD
  session: number;
  topic: string | null; // the session's theme/title
  readings: string[]; // "Watch:"/"Read:" items
  questions: string[]; // the prof's study/prep questions
  caseTitle: string | null; // the assigned case, if any
}

interface Segment {
  date: string;
  session: number;
  seg: string;
}

/** Split a rendered Session Summary page into one text segment per published session. */
function sessionSegments(html: string): Segment[] {
  const joined = decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '),
  ).replace(/\s+/g, ' ');
  const re = /([A-Z][a-z]+) (\d{1,2}), (\d{4})\s+Details \(Session (\d+)\)/g;
  const marks: { date: string; session: number; idx: number }[] = [];
  for (let m = re.exec(joined); m; m = re.exec(joined)) {
    const month = MONTHS[m[1]!];
    if (month === undefined) continue;
    const date = `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    marks.push({ date, session: Number(m[4]), idx: m.index });
  }
  return marks.map((mk, i) => ({
    date: mk.date,
    session: mk.session,
    seg: joined.slice(mk.idx, marks[i + 1]?.idx ?? joined.length),
  }));
}

/** Extract the assigned case title from a session segment (null when none). */
function caseFromSegment(seg: string): string | null {
  // A session can carry several "Case:" tokens: file-link artifacts plus the real
  // assignment. Take the first real title, trimmed at its product code / study-
  // question tail (Ivey prints "Title (HBS 702049) Q1...").
  for (const piece of seg.split(/\bCase:\s*/).slice(1)) {
    if (/^<|^a id=/i.test(piece.trim())) continue; // a file-link artifact
    const stop = piece.search(
      /\s(?:HBS|Ivey)\b|\((?:HBS|Ivey|9B|W\d)|\?|\s\d+\.\s|\b(?:Watch|Read|Prepare|Study Questions):/i,
    );
    const c = (stop >= 0 ? piece.slice(0, stop) : piece).replace(/[.,;\s]+$/, '').trim();
    if (c.length >= 4) return c;
  }
  return null;
}

/**
 * Parse an Ivey "Session Summary" page into full per-session plans: the topic,
 * the assigned readings, the professor's study questions, and the case (if any).
 * Only sessions the professor has published appear.
 */
export function parseSessionPlans(html: string): SessionPlan[] {
  return sessionSegments(html).map(({ date, session, seg }) => {
    const topicM = /SESSION \d+:\s*(.+?)(?=\s(?:Watch:|Read:|Prepare:|Case:|Details|$))/i.exec(seg);
    const readings: string[] = [];
    for (const rm of seg.matchAll(/\b(?:Watch|Read):\s*(.+?)(?=\s(?:Watch:|Read:|Prepare:|Case:|Details|$))/gi)) {
      const r = rm[1]!.replace(/https?:\/\/\S+/g, '').replace(/[.,;\s]+$/, '').trim();
      if (r.length >= 6 && !/[<>]|id=|href=|instructure/i.test(r)) readings.push(r.slice(0, 200));
    }
    // The prof's study questions: clauses that START with a question word and end
    // in "?", which cleanly separates run-together questions and skips the case/
    // reading lines. Noise (schedule headers, citations) is filtered out.
    const NOISE = /Session \d|Details|Watch:|Read:|Prepare:|Case:|http|instructure|id=|\b(?:19|20)\d\d\b|[<>]/i;
    const seen = new Set<string>();
    const questions: string[] = [];
    // Case-SENSITIVE question-word start (a Capitalized word begins a sentence;
    // "in Africa" mid-phrase must not start a match). Ends at "?".
    for (const qm of seg.matchAll(
      /\b(?:What|How|Why|Is|Are|Should|Do|Does|Can|Could|Would|Will|Which|Who|Where|When|Explain|Describe|Discuss|If|In)\b[^?]{5,240}\?/g,
    )) {
      const q = qm[0]!.replace(/^\d+\.\s*/, '').trim();
      const letters = q.replace(/[^A-Za-z]/g, '');
      const upper = (q.match(/[A-Z]/g)?.length ?? 0) / (letters.length || 1);
      if (upper > 0.6) continue; // an ALL-CAPS topic header, not a question
      if (!NOISE.test(q) && !seen.has(q)) {
        seen.add(q);
        questions.push(q);
      }
    }
    return {
      date,
      session,
      topic: topicM ? topicM[1]!.replace(/[.,;\s]+$/, '').trim().slice(0, 200) : null,
      readings: [...new Set(readings)].slice(0, 6),
      questions: questions.slice(0, 8),
      caseTitle: caseFromSegment(seg),
    };
  });
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
 * Refresh a course's per-session plans from its Ivey Session Summary tool.
 * Best-effort and idempotent: launches the tool, parses every published
 * session's topic / readings / study questions / case, writes them to the course
 * profile (so prep is session-specific and preps the prof's own questions), and
 * -- when the course has a multi-case coursepack -- also writes the exact
 * date->case-index map. Returns the number of published sessions found. A no-op
 * (0) when the tool is absent or unreachable. Never throws.
 */
export async function syncIveySessionPlans(
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
    const plans = parseSessionPlans(html);
    if (plans.length === 0) return 0;

    const byDate: Record<string, { topic: string | null; readings: string[]; questions: string[]; caseTitle: string | null }> = {};
    for (const p of plans) {
      byDate[p.date] = { topic: p.topic, readings: p.readings, questions: p.questions, caseTitle: p.caseTitle };
    }
    await setSessionPlans(db, courseId, byDate);

    // Pull the actual readings/primers the Session Summary attaches per session
    // (e.g. GMM's macro primers) so prep is grounded in the reading, not just the
    // questions. Best-effort; a file failure never breaks the sync.
    await ingestSessionFiles(db, auth, canvasCourseId, courseId, html, fetchImpl);

    // If this course has a multi-case coursepack, also pin each date to its case.
    const cp = await db.query<{ text: string }>(
      `SELECT text FROM materials WHERE course_id = $1 AND kind = 'case'
       ORDER BY length(text) DESC LIMIT 1`,
      [courseId],
    );
    if (cp.rows.length > 0) {
      const cases = splitCoursepack(cp.rows[0]!.text);
      if (cases.length >= 2) {
        const entries = plans.filter((p) => p.caseTitle).map((p) => ({ date: p.date, caseTitle: p.caseTitle! }));
        const map = matchScheduleToCases(cases, entries);
        if (Object.keys(map).length > 0) await setCaseSchedule(db, courseId, map);
      }
    }
    return plans.length;
  } catch {
    return 0;
  }
}

/** Only PDFs and text files carry usable text (skip images and Office docs). */
function fileIsReadable(contentType: string, name: string): boolean {
  const ct = (contentType || '').toLowerCase();
  return ct.includes('pdf') || ct.startsWith('text/') || /\.(pdf|txt|md|csv)$/i.test(name);
}

/**
 * Download and ingest the files the Session Summary attaches to each published
 * session, scoped to that session so prep uses the class's own reading. Skips
 * images and Office docs; idempotent on the Canvas file id. Never throws.
 */
async function ingestSessionFiles(
  db: SqlClient,
  auth: CanvasAuth,
  canvasCourseId: number,
  courseId: string,
  html: string,
  fetchImpl: Fetch,
): Promise<number> {
  let ingested = 0;
  for (const { date, seg } of sessionSegments(html)) {
    const fileIds = [...new Set([...seg.matchAll(/files\/(\d+)/g)].map((m) => m[1]!))];
    if (fileIds.length === 0) continue;
    const s = await db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE course_id = $1
         AND to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $2 LIMIT 1`,
      [courseId, date],
    );
    const sessionId = s.rows[0]?.id ?? null;
    for (const id of fileIds) {
      try {
        const meta = (await (
          await fetchImpl(`${auth.baseUrl}/api/v1/courses/${canvasCourseId}/files/${id}`, {
            headers: { Authorization: `Bearer ${auth.token}` },
          })
        ).json()) as { display_name?: string; content_type?: string; url?: string };
        const name = meta.display_name ?? `file-${id}`;
        if (!meta.url || !fileIsReadable(meta.content_type ?? '', name)) continue;
        const bytes = Buffer.from(await (await fetchImpl(meta.url)).arrayBuffer());
        const kind = /\b9B\d|\bW\d{4}\b|case/i.test(name) ? 'case' : 'reading';
        const r = await ingestFileBytes(db, {
          courseId,
          sessionId,
          kind,
          title: name,
          contentType: meta.content_type ?? null,
          source: 'canvas',
          sourceId: `canvas-file:${id}`,
          bytes,
          minChars: 100,
        });
        if (!r.skipped) ingested += 1;
      } catch {
        // a single unreadable/paywalled file must not stop the rest
      }
    }
  }
  return ingested;
}
