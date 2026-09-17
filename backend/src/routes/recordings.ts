import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { generateAndStoreNotes } from '../lectures/process.js';
import type { ModelService } from '../model/service.js';
import { getRecording, registerRecording, setRecordingSession, storeAudio } from '../recordings/service.js';
import type { StorageProvider } from '../storage/provider.js';
import type { TranscriptionProvider } from '../transcription/provider.js';
import { requestTranscription, runTranscription } from '../transcription/service.js';

export interface RecordingRouteDeps {
  transcription?: TranscriptionProvider;
  bus?: EventBus;
  /** When present, notes are generated right after transcription (near-instant,
   * Granola-style) instead of waiting for the scheduled lecture tick. */
  model?: ModelService;
}

const AUDIO_CONTENT_TYPES = [
  'application/octet-stream',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/mpeg',
];

/** Register recording metadata + audio upload routes. */
export function registerRecordingRoutes(
  app: FastifyInstance,
  db: SqlClient,
  storage: StorageProvider,
  deps: RecordingRouteDeps = {},
): void {
  // Collect raw audio bytes as a Buffer for the upload endpoint.
  app.addContentTypeParser(AUDIO_CONTENT_TYPES, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/recordings', async (req, reply) => {
    const parsed = z
      .object({
        client_id: z.string().min(1),
        content_type: z.string().optional(),
        title: z.string().optional(),
        captured_at: z.string().optional(),
        duration_ms: z.number().int().nonnegative().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const rec = await registerRecording(db, {
      clientId: parsed.data.client_id,
      contentType: parsed.data.content_type,
      title: parsed.data.title,
      capturedAt: parsed.data.captured_at,
      durationMs: parsed.data.duration_ms,
    });
    return { id: rec.id, status: rec.status, upload_path: `/recordings/${rec.id}/audio` };
  });

  // Re-point a recording to the correct class session (manual override when the
  // automatic time-match got it wrong). session_id null unlinks it.
  app.put('/recordings/:id/session', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = z.object({ session_id: z.string().uuid().nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    const ok = await setRecordingSession(db, params.data.id, body.data.session_id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Lecture recordings are large; allow up to 500 MB (default Fastify cap is 1 MB).
  app.put('/recordings/:id/audio', { bodyLimit: 500 * 1024 * 1024 }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty_body' });
    }
    const existing = await getRecording(db, params.data.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const res = await storeAudio(db, storage, params.data.id, body);

    // Kick off transcription in the background so the upload returns immediately.
    // requestTranscription is idempotent; a failed run leaves the audio intact
    // and marks the transcript retryable.
    if (deps.transcription && deps.bus) {
      const { transcription, bus, model } = deps;
      void (async () => {
        try {
          const t = await requestTranscription(db, params.data.id);
          await runTranscription(db, storage, transcription, bus, t.id);
          // Granola-style: generate the notes right after transcription so they
          // appear on their own within seconds. Best-effort - the scheduled
          // lecture tick is the reliable backstop if the container scales down
          // mid-generation.
          if (model) await generateAndStoreNotes(db, model, t.id);
        } catch (err) {
          app.log.error({ err, recording: params.data.id }, 'transcription/notes failed');
        }
      })();
    }

    return { status: 'stored', key: res.key, size: res.size };
  });
}
