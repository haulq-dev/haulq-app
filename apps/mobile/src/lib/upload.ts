/**
 * Getting paperwork from the phone to `POST /v1/documents`.
 *
 * **Photos are shrunk before they're sent.** A phone camera takes a 12 MP,
 * 3–5 MB picture, and a cab's connection is intermittent. 2400 px on the long
 * side at JPEG quality 0.85 is still well above what OCR needs for a
 * letter-size BOL, and it's a fraction of the upload. PDFs are sent as-is.
 * So is any image the WebView can't decode (an iPhone HEIC on Android, say),
 * because the API accepts HEIC and a failed shrink must never lose the file.
 *
 * Each file is one request, sent one after another, so a flaky connection
 * fails one file and reports it rather than losing the whole batch.
 */

import { MAX_DOCUMENT_BYTES, uploadSummary } from '@haulq/client';
import { request } from './api.ts';

const MAX_EDGE_PX = 2400;
const JPEG_QUALITY = 0.85;

export interface UploadTarget {
  /** Attach on arrival. A driver may name only their own load; the API checks. */
  loadId?: string;
  /** Skip classification when the sender already knows what it is ("this is the POD"). */
  kind?: string;
}

export interface UploadResult {
  added: number;
  already: number;
  failed: Array<{ name: string; error: unknown }>;
  summary: string;
}

export async function uploadDocuments(files: File[], target: UploadTarget = {}): Promise<UploadResult> {
  let added = 0;
  let already = 0;
  const failed: UploadResult['failed'] = [];

  for (const original of files) {
    try {
      const file = await shrinkIfPhoto(original);
      if (file.size > MAX_DOCUMENT_BYTES) {
        throw new Error(`${original.name} is over 25 MB. Send it as a smaller scan or split the pages.`);
      }
      const params = new URLSearchParams({
        filename: file.name,
        ...(target.loadId ? { loadId: target.loadId } : {}),
        ...(target.kind ? { kind: target.kind } : {}),
      });
      const res = await request<{ deduped: boolean }>(`/v1/documents?${params}`, {
        // The API sniffs the bytes regardless. The type only has to get the
        // request past the content-type parser.
        raw: { body: file, contentType: file.type || 'application/octet-stream' },
      });
      if (res.deduped) already += 1;
      else added += 1;
    } catch (error) {
      failed.push({ name: original.name, error });
    }
  }

  return { added, already, failed, summary: uploadSummary(added, already) };
}

async function shrinkIfPhoto(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === 'image/jpeg') {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
