/**
 * The handful of shared pieces.
 *
 * Small on purpose. A component library for six screens is a guess about what
 * screens seven through twenty will need, and the brand system in `styles.css`
 * already does most of the work.
 */

import type { ReactNode } from 'react';
import { ApiRequestError } from '../lib/api.ts';

export function Label({ children }: { children: ReactNode }) {
  return <span className="field-label text-mute">{children}</span>;
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border border-line bg-white">
      {title && (
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-lg">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/**
 * Money, always from integer minor units.
 *
 * There is no code path in this app that turns cents into a float and formats
 * that. Build plan section 5 — never floats near an invoice — is a property of
 * the display layer too, since a rounded figure on screen is what a carrier
 * will quote back to a broker.
 */
export function Money({ cents, className = '' }: { cents: number; className?: string }) {
  return (
    <span className={`num ${className}`}>
      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
        cents / 100,
      )}
    </span>
  );
}

export function Num({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`num ${className}`}>{value.toLocaleString('en-US')}</span>;
}

/**
 * An error, rendered from the API's own explanation.
 *
 * Never invents prose from a status code. The API guarantees a sentence a
 * carrier can act on, and the whole point of that guarantee is that this
 * component can be dumb.
 */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiRequestError
      ? error.explanation
      : error instanceof Error
        ? error.message
        : String(error);

  return (
    <p className="border-l-2 border-bad bg-bad-50 px-3 py-2 text-sm text-bad" role="alert">
      {message}
    </p>
  );
}

/** Validation feedback. Warnings inform, errors block — see operating-facts.ts. */
export function IssueNote({
  severity,
  children,
}: {
  severity: 'error' | 'warning';
  children: ReactNode;
}) {
  const tone =
    severity === 'error'
      ? 'border-bad bg-bad-50 text-bad'
      : 'border-warn bg-warn-50 text-warn';
  return (
    <p className={`mt-1 border-l-2 px-2 py-1 text-xs ${tone}`}>{children}</p>
  );
}

export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: 'ok' | 'warn' | 'neutral';
  children: ReactNode;
}) {
  const tones = {
    ok: 'bg-ok-50 text-ok border-ok',
    warn: 'bg-warn-50 text-warn border-warn',
    neutral: 'bg-wash text-slate border-line',
  } as const;
  return (
    <span className={`field-label border px-2 py-1 ${tones[tone]}`}>{children}</span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-sm text-mute">{children}</p>;
}

/**
 * The one control every cursor-paginated list in this app shares. Appends
 * the next page rather than replacing the current one or jumping to a page
 * number — the API's own pagination is keyset/cursor-based (see
 * `packages/db/src/pagination.ts`), which has no notion of "page 4" to jump
 * to, only "the rows after the last one I have."
 */
export function LoadMore({
  onClick,
  loading,
  hasMore,
}: {
  onClick: () => void;
  loading: boolean;
  hasMore: boolean;
}) {
  if (!hasMore) return null;
  return (
    <div className="mt-4 flex justify-center">
      <button className="hq-btn hq-btn-ghost" disabled={loading} onClick={onClick}>
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="field-label mb-1.5 block text-slate">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-mute">{hint}</span>}
    </label>
  );
}
