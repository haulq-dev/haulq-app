/**
 * Documents: what `GET /v1/documents` returns, and the small rules both front
 * ends apply. Copied from `apps/web/src/routes/Documents.tsx` for the mobile
 * port (MOBILE_PARITY_PLAN.md M2). Web still declares its own copy.
 *
 * The validation verdict itself is not here. It comes from
 * `summarizeValidation` in `@haulq/contracts`, the same function the
 * repository used to store the status, so a screen and the database can't
 * disagree about what "rejected" means.
 */

import { documentKindLabel, type ValidationFinding } from '@haulq/contracts';

export interface DocumentRow {
  id: string;
  kind: string;
  kindConfidence: number | null;
  status: string;
  source: string;
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  pageCount: number | null;
  sha256: string;
  loadId: string | null;
  receivedFrom: string | null;
  receivedAt: string;
  extracted: Record<string, unknown> | null;
  extractedAt: string | null;
  extractorVersion: string | null;
  validation: ValidationFinding[] | null;
  validatedAt: string | null;
  rejectionReason: string | null;
}

export interface DocumentsPage {
  items: DocumentRow[];
  nextCursor: string | null;
}

export const DOCUMENT_STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  validated: 'ok',
  rejected: 'warn',
  quarantined: 'warn',
};

/** What the API's sniffer accepts. Advisory only; the bytes decide. */
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.tif,.tiff,.heic,application/pdf,image/*';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export function fileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `brokerLoadNumber` → `broker load number`. A validation finding's field, read as words. */
export const humanizeField = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

/** What was printed for a field, per extraction, or '' if it was never found. */
export function extractedRaw(document: Pick<DocumentRow, 'extracted'>, field: string): string {
  const found = document.extracted?.[field] as { raw?: unknown } | undefined;
  return typeof found?.raw === 'string' ? found.raw : '';
}

/**
 * The upload summary, deduplicated uploads included. Sending the same file
 * twice is harmless (HaulQ keeps one copy), so a repeat is reported, not
 * silently dropped. Someone who sees nothing happen re-sends and assumes it
 * failed.
 */
export function uploadSummary(added: number, already: number): string {
  return [added ? `${added} added` : null, already ? `${already} you already had` : null].filter(Boolean).join(', ');
}

/** Acronyms a title-cased label would get wrong ("Pod", "Bol", "W9"). */
const KIND_TITLE: Record<string, string> = { pod: 'POD', bol: 'BOL', w9: 'W-9' };

/** A document kind as a heading: `pod` → "POD", `rate_confirmation` → "Rate confirmation". */
export function documentTitle(kind: string): string {
  const known = KIND_TITLE[kind];
  if (known) return known;
  const words = documentKindLabel(kind);
  return words.charAt(0).toUpperCase() + words.slice(1);
}
