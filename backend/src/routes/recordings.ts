import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SqlClient } from '../db/client.js';
import { getRecording, registerRecording, storeAudio } from '../recordings/service.js';
import type { StorageProvider } from '../storage/provider.js';

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

  app.put('/recordings/:id/audio', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty_body' });
    }
    const existing = await getRecording(db, params.data.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const res = await storeAudio(db, storage, params.data.id, body);
    return { status: 'stored', key: res.key, size: res.size };
  });
}
