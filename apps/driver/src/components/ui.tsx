/**
 * The handful of shared pieces, trimmed from `apps/web/src/components/ui.tsx`
 * to the ones this single-screen app actually uses. Same duplication trade
 * `styles.css` documents — two independent deploys, not a shared package.
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
    <section className="border border-line bg-white">
      {title && (
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-lg">{title}</h2>
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
    <p className="border-l-2 border-bad bg-bad-50 px-3 py-2 text-sm text-bad" role="alert">
      {message}
    </p>
  );
}
