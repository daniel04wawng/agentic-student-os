/**
 * Emit JSON Schema from the canonical zod contracts so non-TS consumers
 * (Python inference service, SwiftUI app) can share the same shapes.
 *
 * Output is written with sorted keys + trailing newline so regeneration is
 * byte-for-byte deterministic (see acceptance criterion: re-run yields
 * identical output). Run: `npm run shared:generate`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import { HealthResponseSchema } from '../src/health.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated');

/** name -> schema. Add contracts here as later PRs introduce them. */
const REGISTRY: Record<string, ZodType> = {
  'health-response': HealthResponseSchema,
};

/** JSON.stringify replacer that sorts object keys for stable output. */
function sortKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, schema] of Object.entries(REGISTRY)) {
    const jsonSchema = zodToJsonSchema(schema, { name, target: 'jsonSchema7' });
    const serialized = JSON.stringify(jsonSchema, sortKeys, 2) + '\n';
    const outPath = join(OUT_DIR, `${name}.schema.json`);
    writeFileSync(outPath, serialized, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${outPath}`);
  }
}

main();
