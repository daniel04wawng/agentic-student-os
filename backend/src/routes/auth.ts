import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAppleIdToken } from '../auth/apple.js';
import { issueTokens, verifySessionToken } from '../auth/tokens.js';
import type { SqlClient } from '../db/client.js';
import { upsertUserByAppleSub } from '../users/service.js';

export interface AuthRouteOptions {
  jwtSecret: string;
  appleClientId: string;
  /** Injectable fetch for testing the Apple verification. */
  fetchImpl?: typeof fetch;
}

/**
 * Public sign-in endpoints. `/auth/apple` verifies a Sign in with Apple identity
 * token against Apple's keys, upserts the user, and returns our own session
 * tokens. `/auth/refresh` swaps a valid refresh token for a fresh pair. These
 * must be exempt from the bearer requirement (they are how you get a bearer).
 */
export function registerAuthRoutes(app: FastifyInstance, db: SqlClient, opts: AuthRouteOptions): void {
  app.post('/auth/apple', async (req, reply) => {
    const parsed = z.object({ id_token: z.string().min(1), nonce: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    let identity;
    try {
      identity = await verifyAppleIdToken(parsed.data.id_token, {
        clientId: opts.appleClientId,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      return reply.code(401).send({ error: 'invalid_apple_token', reason: err instanceof Error ? err.message : 'invalid' });
    }

    const userId = await upsertUserByAppleSub(db, identity.appleSub, identity.email);
    const tokens = issueTokens(userId, opts.jwtSecret);
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt,
      user_id: userId,
    };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const parsed = z.object({ refresh_token: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const { userId } = verifySessionToken(parsed.data.refresh_token, opts.jwtSecret, 'refresh');
      const tokens = issueTokens(userId, opts.jwtSecret);
      return {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
        user_id: userId,
      };
    } catch {
      return reply.code(401).send({ error: 'invalid_refresh' });
    }
  });
}
