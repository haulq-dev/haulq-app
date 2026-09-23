/**
 * The handful of shared pieces, trimmed from `apps/web/src/components/ui.tsx`
 * to the ones this single-screen app actually uses. Same duplication trade
 * `styles.css` documents — two independent deploys, not a shared package —
 * except this copy diverges further: iOS grouped-card language (`.hq-card`,
 * `.hq-pill` from styles.css), not apps/web's square hairline-border look.
 */

import type { ReactNode } from 'react';
import { isNotEntitled, isSubscriptionInactive } from '@haulq/client';
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
  children,
}: {
  tone?: 'ok' | 'warn' | 'neutral';
  children: ReactNode;
}) {
  const tones = {
    ok: 'bg-ok-50 text-ok',
    warn: 'bg-warn-50 text-warn',
    neutral: 'bg-wash text-slate',
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
