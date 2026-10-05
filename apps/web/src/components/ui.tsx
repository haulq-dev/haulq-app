/**
 * The handful of shared pieces.
 *
 * Small on purpose. A component library for six screens is a guess about what
 * screens seven through twenty will need, and the brand system in `styles.css`
 * already does most of the work.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiRequestError } from '../lib/api.ts';

/**
 * The browser tab's title, most specific part first: "Load #4412 · Loads · HaulQ".
 * A dispatcher with Loads, a load and Pay open in three tabs can tell them
 * apart. Falsy parts are dropped, so a title can name a load once it's loaded.
 */
export function useDocumentTitle(...parts: (string | null | undefined | false)[]) {
  const title = [...parts.filter(Boolean), 'HaulQ'].join(' · ');
  useEffect(() => {
    document.title = title;
  }, [title]);
}

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

/**
 * A short "that worked" note in the corner, for actions whose result is
 * otherwise easy to miss: the row moved out of the current filter, the panel
 * closed, or nothing on screen visibly changes. Failures stay inline as
 * `ErrorNote`, next to what failed — a toast that vanishes is the wrong place
 * for something that still needs fixing.
 *
 * Outside a `ToastProvider` (screens under test) it does nothing.
 */
const ToastContext = createContext<(message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const TOAST_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string) => {
    const id = ++nextId.current;
    // Three at most; a burst of saves shouldn't stack up the screen.
    setToasts((current) => [...current.slice(-2), { id, message }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always mounted, so screen readers have the live region before the first message lands in it. */}
      <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="border-l-2 border-ok bg-ink px-4 py-2.5 text-sm text-white">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * A button that asks before it acts, inline: the first click swaps it for the
 * question and a confirm/cancel pair. The same shape as voiding an invoice or
 * taking a truck out of service, minus the reason field, and in the page's
 * own type rather than the browser's grey `window.confirm` box. Escape backs
 * out.
 */
export function ConfirmButton({
  children,
  question,
  confirmLabel,
  busy = false,
  busyLabel,
  onConfirm,
  className = 'hq-btn hq-btn-ghost text-bad',
}: {
  children: ReactNode;
  question: string;
  confirmLabel: string;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button type="button" className={className} disabled={busy} onClick={() => setAsking(true)}>
        {busy && busyLabel ? busyLabel : children}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}>
      <span className="text-sm text-slate">{question}</span>
      <button
        type="button"
        className="hq-btn hq-btn-ghost text-bad"
        // The button that was clicked is gone; focus lands here rather than on the page body.
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </div>
  );
}
