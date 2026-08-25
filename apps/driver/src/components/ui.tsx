/**
 * The handful of shared pieces, trimmed from `apps/web/src/components/ui.tsx`
 * to the ones this single-screen app actually uses. Same duplication trade
 * `styles.css` documents — two independent deploys, not a shared package —
 * except this copy diverges further: iOS grouped-card language (`.hq-card`,
 * `.hq-pill` from styles.css), not apps/web's square hairline-border look.
 */

import type { ReactNode } from 'react';
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

/** Never invents prose from a status code — see the note in the web app's copy of this. */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiRequestError
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
