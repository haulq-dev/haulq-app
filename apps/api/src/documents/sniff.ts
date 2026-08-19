/**
 * What kind of file is this, actually.
 *
 * The declared `content-type` on an upload is a claim, not a fact. Browsers send
 * `application/octet-stream` for anything they do not recognise, scanner
 * software lies, and a driver's phone will happily label a HEIC as a JPEG. Every
 * one of those is harmless until the extractor is handed bytes it cannot read
 * and fails with a message about page counts.
 *
 * So the bytes decide. `sniff` reads the leading magic number and returns the
 * media type it actually is, or null when it is nothing HaulQ handles. The route
 * stores the sniffed type rather than the declared one, which means a document
 * uploaded as `octet-stream` still comes back out of the API as a PDF.
 *
 * This is not a virus check and does not pretend to be. It answers "can the
 * pipeline read this", nothing more — `documents.status = 'quarantined'` exists
 * for the other question, and whatever fills it will live somewhere else.
 */

/** Media types the document pipeline can do something with. */
export const SUPPORTED_DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/heic',
] as const;

export type SupportedDocumentType = (typeof SUPPORTED_DOCUMENT_TYPES)[number];

const starts = (buf: Buffer, bytes: number[]): boolean =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

/**
 * Identify a document by its leading bytes.
 *
 * Returns null for anything unrecognised, including an empty buffer. Callers
 * treat null as "refuse this upload" rather than "assume PDF" — guessing here
 * moves the failure to the extractor, hours later, where the carrier reads it as
 * HaulQ losing their paperwork.
 */
export function sniff(buf: Buffer): SupportedDocumentType | null {
  // %PDF-
  if (starts(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';

  // JPEG SOI + first marker byte.
  if (starts(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG signature, all eight bytes. The trailing CR LF SUB LF is there to catch
  // a transfer that mangled line endings, which is exactly the failure mode a
  // Windows carrier hits, so it is worth checking rather than matching on
  // \x89PNG alone.
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  // TIFF, little and big endian. Fax-style scanners still emit these.
  if (starts(buf, [0x49, 0x49, 0x2a, 0x00])) return 'image/tiff';
  if (starts(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';

  // ISO base media: a 4-byte box length, then 'ftyp', then a brand. iPhone
  // photos of a bill of lading arrive as these and are the single most common
  // driver upload.
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }

  return null;
}

/**
 * A filename safe to store and to echo back in a header.
 *
 * Path separators, `..` and control characters all removed — the value reaches
 * `Content-Disposition`, and a newline in there is a response-splitting bug
 * rather than a cosmetic one.
 */
export function safeFilename(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? '')
    .replace(/[\r\n]/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\w.\- ]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);

  return cleaned || fallback;
}
