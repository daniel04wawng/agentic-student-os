import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Object-storage abstraction. Audio blobs are written here, referenced by key
 * from the `recordings` row. Implementations: in-memory + local FS for
 * dev/tests; S3/Supabase Storage (with presigned uploads) in production.
 */
export interface StorageProvider {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

/** In-memory store for tests. */
export class InMemoryStorageProvider implements StorageProvider {
  private readonly blobs = new Map<string, Buffer>();

  async put(key: string, bytes: Buffer): Promise<void> {
    this.blobs.set(key, bytes);
  }
  async get(key: string): Promise<Buffer> {
    const blob = this.blobs.get(key);
    if (!blob) throw new Error(`not found: ${key}`);
    return blob;
  }
  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }
}

/** Local filesystem store for single-node dev. */
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, key);
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}
