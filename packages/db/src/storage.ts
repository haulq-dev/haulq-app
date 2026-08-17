/**
 * Object storage.
 *
 * Bytes never go in Postgres. This is the seam between the database records
 * that point at a file and whatever actually holds it.
 *
 * Two implementations: a filesystem one for development and CI, and — once the
 * bucket and Doppler secrets exist — Cloudflare R2. The interface is
 * deliberately four methods wide. R2 speaks S3, so an S3 implementation is the
 * same code with a different endpoint, and keeping the surface small is what
 * makes that true.
 *
 * Phase 1a (HaulQ Docs) needs exactly this for rate confirmations and PODs, at
 * far higher volume. Getting the shape right for a CSV that is read once is
 * cheap; getting it wrong and discovering it under Docs is not.
 *
 * ---------------------------------------------------------------------------
 * Keys are tenant-scoped, always
 * ---------------------------------------------------------------------------
 *
 * `key()` below is the only sanctioned way to build one, and it puts the org
 * first. That makes a per-tenant lifecycle rule expressible in R2's console, it
 * makes "delete everything for this carrier" a prefix delete, and it means a
 * key accidentally logged somewhere reveals which tenant it belongs to rather
 * than being an opaque token that has to be traced.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface StoredObject {
  key: string;
  byteSize: number;
  /** Hex sha256. The dedupe key everywhere downstream. */
  sha256: string;
}

export interface ObjectStore {
  readonly name: string;
  put(key: string, body: Buffer, contentType?: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/**
 * Build a storage key.
 *
 * `filename` is not trusted — it comes from a browser upload and may contain
 * path separators, `..`, or a null byte. Only the extension is kept, and the
 * body of the name is replaced with the caller's id.
 */
export function key(parts: {
  orgId: string;
  kind: 'imports' | 'documents';
  id: string;
  filename?: string;
}): string {
  const ext = parts.filename?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return `${parts.orgId}/${parts.kind}/${parts.id}${ext ? `.${ext}` : ''}`;
}

export function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Filesystem store, for development and CI.
 *
 * The traversal check is not theatre. Keys are built from ids here, but this
 * class will outlive the assumption that every caller uses `key()`, and one
 * `../../etc` reaching `readFile` is the difference between a dev convenience
 * and a file disclosure bug.
 */
export class FilesystemObjectStore implements ObjectStore {
  readonly name = 'filesystem';
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key_: string): string {
    const full = resolve(join(this.#root, key_));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new Error(`storage key escapes the root: ${key_}`);
    }
    return full;
  }

  async put(key_: string, body: Buffer): Promise<StoredObject> {
    const path = this.#path(key_);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key: key_, byteSize: body.byteLength, sha256: sha256(body) };
  }

  async get(key_: string): Promise<Buffer> {
    return readFile(this.#path(key_));
  }

  async delete(key_: string): Promise<void> {
    await rm(this.#path(key_), { force: true });
  }

  async exists(key_: string): Promise<boolean> {
    try {
      await readFile(this.#path(key_));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * In-memory store, for tests that do not care where the bytes went.
 */
export class MemoryObjectStore implements ObjectStore {
  readonly name = 'memory';
  readonly #objects = new Map<string, Buffer>();

  async put(key_: string, body: Buffer): Promise<StoredObject> {
    this.#objects.set(key_, body);
    return { key: key_, byteSize: body.byteLength, sha256: sha256(body) };
  }

  async get(key_: string): Promise<Buffer> {
    const found = this.#objects.get(key_);
    if (!found) throw new Error(`no object at ${key_}`);
    return found;
  }

  async delete(key_: string): Promise<void> {
    this.#objects.delete(key_);
  }

  async exists(key_: string): Promise<boolean> {
    return this.#objects.has(key_);
  }
}

/**
 * What the R2 implementation will look like, for whoever writes it.
 *
 * R2 is S3-compatible, so this is `@aws-sdk/client-s3` pointed at
 * `https://<account>.r2.cloudflarestorage.com` with region `auto`. Two things
 * that are easy to get wrong and expensive to discover later:
 *
 *  - **Do not enable public bucket access.** Every read goes through the API
 *    with a tenant check. A rate confirmation is a commercial document with a
 *    carrier's rates in it.
 *  - **Set a lifecycle rule per `kind` prefix**, not one for the bucket.
 *    Imports can expire; documents attached to an invoice cannot, and guardrail
 *    4's retention rules for board-sourced data are different again.
 */
export const R2_NOTES = undefined;
