import type { SqlClient } from '../db/client.js';

/**
 * Find or create the user for a Sign in with Apple identity. Apple sends the
 * email only on the FIRST authorization, so we keep the stored one on later
 * sign-ins. Returns our internal user id (the tenant id).
 */
export async function upsertUserByAppleSub(
  db: SqlClient,
  appleSub: string,
  email: string | null,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (apple_sub, email) VALUES ($1, $2)
     ON CONFLICT (apple_sub) DO UPDATE SET email = COALESCE(excluded.email, users.email)
     RETURNING id`,
    [appleSub, email],
  );
  return res.rows[0]!.id;
}
