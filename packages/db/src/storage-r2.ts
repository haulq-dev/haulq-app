/**
 * Cloudflare R2, behind the same four-method `ObjectStore` interface.
 *
 * R2 speaks S3, so this is `@aws-sdk/client-s3` pointed at an R2 endpoint.
 * Kept in its own file so `storage.ts` stays on node builtins only — the
 * filesystem and in-memory stores are what CI and a fresh clone run on, and
 * they should not need a 2 MB AWS SDK on the import path to do it.
 *
 * ---------------------------------------------------------------------------
 * The checksum setting is not optional
 * ---------------------------------------------------------------------------
 *
 * `requestChecksumCalculation` and `responseChecksumValidation` are set to
 * `WHEN_REQUIRED` deliberately. From `@aws-sdk/client-s3` v3.729.0 the SDK
 * started sending flexible checksum headers on PutObject and UploadPart by
 * default, and R2 rejects them:
 *
 *     Header 'x-amz-checksum-crc32' with value '...' not implemented
 *
 * Every upload fails, and it fails at the SDK/R2 boundary rather than anywhere
 * in this file, so it reads like a credentials or endpoint problem. Removing
 * these two lines is how someone rediscovers that in production.
 *
 * The same report notes the workaround does not cover `DeleteObjects` — the
 * plural, batch form. `delete()` below uses the singular `DeleteObjectCommand`,
 * which is unaffected. If a bulk delete is ever added, that is where to look.
 *
 * ---------------------------------------------------------------------------
 * Two things this must never become
 * ---------------------------------------------------------------------------
 *
 *  - **Public.** The bucket stays private and every read goes through the API
 *    with a tenant check. A rate confirmation is a commercial document with a
 *    carrier's rates in it.
 *  - **Lifecycle-ruled at the bucket level.** Rules belong on the `kind` prefix.
 *    Imports can expire; documents attached to an invoice cannot, and
 *    guardrail 4's retention for board-sourced data is different again. `key()`
 *    in `storage.ts` puts the org first and the kind second precisely so both
 *    are expressible.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { sha256, type ObjectStore, type StoredObject } from './storage.ts';

export interface R2Config {
  /** Cloudflare account id. The endpoint is derived from it. */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Override the endpoint. Only for pointing the suite at a local S3 stand-in;
   * production derives it from `accountId`.
   */
  endpoint?: string;
  /** Path-style addressing. R2 does not need it; local stand-ins usually do. */
  forcePathStyle?: boolean;
}



function notFound(error: unknown): boolean {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

export class R2ObjectStore implements ObjectStore {
  readonly name = 'r2';
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: R2Config) {
    this.#bucket = config.bucket;
    this.#client = new S3Client({
      // Required by the SDK, ignored by R2. Bucket location is set at creation.
      region: 'auto',
      endpoint:
        config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // See the module note. Do not remove.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<StoredObject> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );

    // Hashed locally rather than read back from the response, so the digest is
    // computed the same way in every implementation. It is the dedupe key on
    // `documents`, and two stores disagreeing about it would split one file
    // into two rows.
    return { key, byteSize: body.byteLength, sha256: sha256(body) };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`no object at ${key}`);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    // S3 semantics: deleting something absent succeeds. Matches the filesystem
    // store's `rm --force`, so callers do not need to know which they hold.
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (notFound(error)) return false;
      // Deliberately rethrown. The filesystem store swallows everything and
      // answers false, which is survivable for a local file and actively
      // misleading here: expired credentials, a wrong bucket name and a
      // network failure would all report "that document does not exist".
      throw error;
    }
  }

  /** Release sockets. Call on shutdown, same as the database pool. */
  destroy(): void {
    this.#client.destroy();
  }
}

/**
 * An R2 store from environment variables, or null if it is not configured.
 *
 * All four or none. Three out of four is a deployment someone half-finished,
 * and silently falling back to the local disk for it is how uploads vanish on
 * the next deploy with nothing in the logs to say why. The caller decides what
 * to do about null — see `buildStorage` in `apps/api/src/server.ts`, which
 * warns loudly when that happens in production.
 *
 * Narrowing happens here rather than at the call site so nothing downstream
 * needs a non-null assertion.
 */
export function r2FromEnv(env: {
  R2_ACCOUNT_ID?: string | undefined;
  R2_ACCESS_KEY_ID?: string | undefined;
  R2_SECRET_ACCESS_KEY?: string | undefined;
  R2_BUCKET?: string | undefined;
}): R2ObjectStore | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return null;
  }
  return new R2ObjectStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  });
}
