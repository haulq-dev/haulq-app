/**
 * Pieces every section of the office load screen uses.
 */

import { queryKeys } from '@haulq/client';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A collapsible card. The load screen has a dozen things on it, so the
 * everyday ones are open (status, progress) and the occasional ones (stop
 * editing, feasibility, broker settings) start closed. A phone screen then
 * opens on what's happening, not on a form.
 */
export function Section({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Shown beside the title while closed, e.g. "Authorized" or "2 stops". */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="hq-card group overflow-hidden" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">{title}</span>
        <span className="flex items-center gap-2 text-sm text-mute">
          {summary}
          <svg viewBox="0 0 20 20" className="h-4 w-4 transition-transform group-open:rotate-90" fill="currentColor" aria-hidden>
            <path d="M7.3 4.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L11.6 10 7.3 5.7a1 1 0 0 1 0-1.4Z" />
          </svg>
        </span>
      </summary>
      <div className="space-y-3 border-t border-line p-4">{children}</div>
    </details>
  );
}

/**
 * After a write to a load, refresh everything that shows it: the load, its
 * lists (every filter and search, via the `loads` prefix), its tracking and
 * its margin. Narrower than web's blanket `invalidateQueries()`, which
 * refetches every query in the app on a phone connection.
 */
export function useRefreshLoad(loadId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.load(loadId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.loads }),
      queryClient.invalidateQueries({ queryKey: queryKeys.loadTracking(loadId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.loadMargin(loadId) }),
    ]);
}

export const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
