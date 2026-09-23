/**
 * The shared pieces, trimmed from `apps/web/src/components/ui.tsx` to the
 * ones this app uses, growing as MOBILE_PARITY_PLAN.md's phases port screens. Same duplication trade
 * `styles.css` documents — two independent deploys, not a shared package —
 * except this copy diverges further: iOS grouped-card language (`.hq-card`,
 * `.hq-pill` from styles.css), not apps/web's square hairline-border look.
 */

import { cloneElement, isValidElement, useId, type ReactNode } from 'react';
import { formatMoney, isNotEntitled, isSubscriptionInactive } from '@haulq/client';
import { ApiRequestError } from '../lib/api.ts';

export function Card({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="hq-card overflow-hidden">
      {title && (
        <header className="px-4 pt-4 pb-1">
          <h2 className="text-base text-mute">{title}</h2>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Pill({
  tone = 'neutral',
  onPage = false,
  children,
}: {
  tone?: 'ok' | 'warn' | 'neutral';
  /** Sitting on the grey page rather than a white card, where a neutral pill's grey would vanish. */
  onPage?: boolean;
  children: ReactNode;
}) {
  const tones = {
    ok: 'bg-ok-50 text-ok',
    warn: 'bg-warn-50 text-warn',
    neutral: onPage ? 'bg-card text-slate' : 'bg-wash text-slate',
  } as const;
  return <span className={`hq-pill ${tones[tone]}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-sm text-mute">{children}</p>;
}

/**
 * Never invents prose from a status code — see the note in the web app's copy of this.
 *
 * Two exceptions, where the API's own explanation is replaced on purpose.
 * The plan-gate text reads "Contact hello@haulq.ai to upgrade", which is a
 * purchase call to action. The paywall text points at haulq.ai. The iOS app
 * must show neither (Guideline 3.1.1, MOBILE_PARITY_PLAN.md section 2), so
 * both get neutral wording here that says what happened and nothing about
 * where to pay.
 */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = isNotEntitled(error)
    ? "This isn't included in your carrier's HaulQ plan."
    : isSubscriptionInactive(error)
      ? "This carrier's HaulQ account isn't active right now."
      : error instanceof ApiRequestError
        ? error.explanation
        : error instanceof Error
          ? error.message
          : String(error);

  return (
    <p className="hq-card bg-bad-50 px-3 py-2.5 text-sm text-bad shadow-none" role="alert">
      {message}
    </p>
  );
}

/**
 * A labelled form control. The label sits above, the hint below, iOS-settings style.
 *
 * A single input, select or textarea gets a real `htmlFor`/`id` pair, with
 * the hint as its `aria-describedby`, so a screen reader announces "Truck",
 * not "Truck Required from dispatched onward". Anything else, such as an
 * input with a button beside it, is wrapped in the label instead.
 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const hintNode = hint && (
    <span id={hintId} className="block text-xs text-mute">
      {hint}
    </span>
  );

  if (isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) && typeof children.type === 'string' && CONTROLS.has(children.type)) {
    return (
      <div className="space-y-1.5">
        <label htmlFor={id} className="field-label block">
          {label}
        </label>
        {cloneElement(children, { id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
        {hintNode}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="field-label block">{label}</span>
        {children}
      </label>
      {hintNode}
    </div>
  );
}

const CONTROLS = new Set(['input', 'select', 'textarea']);

export function Money({ cents }: { cents: number }) {
  return <span className="num">{formatMoney(cents)}</span>;
}

/** Cursor pagination's "more" button, the same contract as web's `LoadMore`. */
export function LoadMore({ onClick, loading, hasMore }: { onClick: () => void; loading: boolean; hasMore: boolean }) {
  if (!hasMore) return null;
  return (
    <button type="button" className="hq-btn hq-btn-ghost w-full" disabled={loading} onClick={onClick}>
      {loading ? 'Loading…' : 'Load more'}
    </button>
  );
}

/** A plain, expected-state note, not an error: "routing isn't connected", "not checked yet". */
export function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-[var(--radius-sm)] bg-wash px-3 py-2 text-sm text-mute">{children}</p>;
}
