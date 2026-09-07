/**
 * Emit JSON Schema from the canonical zod contracts so non-TS consumers
 * (Python inference service, SwiftUI app) can share the same shapes.
 *
 * Output is written with sorted keys + trailing newline so regeneration is
 * byte-for-byte deterministic. `renderSchemas()` is a pure function (no I/O) so
 * tests can assert determinism in-process; `main()` writes the files and runs
 * only when this script is executed directly. Run: `npm run shared:generate`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import { HealthResponseSchema } from '../src/health.js';

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated');

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

/** Pure: render every registered contract to its serialized JSON Schema string. */
export function renderSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(REGISTRY)) {
    const jsonSchema = zodToJsonSchema(schema, { name, target: 'jsonSchema7' });
    out[name] = JSON.stringify(jsonSchema, sortKeys, 2) + '\n';
  }
  return out;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, serialized] of Object.entries(renderSchemas())) {
    const outPath = join(OUT_DIR, `${name}.schema.json`);
    writeFileSync(outPath, serialized, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${outPath}`);
  }
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
