/**
 * Connected boards and ELDs.
 *
 * One provider today — Motive — reached the same way Stripe Checkout or
 * Clerk's own sign-in is: fetch a URL with the normal authenticated client,
 * then navigate the browser to it by hand. A plain `<a href>` to an
 * authenticated API route would carry none of the headers `requireScope`
 * needs; see the note in `apps/api/src/routes/integrations.ts`.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';
import { request } from '../lib/api.ts';

interface BoardCredential {
  id: string;
  board: string;
  status: 'unverified' | 'active' | 'failed' | 'revoked';
  tokenExpiresAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  active: 'ok',
  failed: 'warn',
  revoked: 'warn',
  unverified: 'neutral',
};

const BOARD_LABEL: Record<string, string> = {
  motive: 'Motive',
};

/**
 * The redirect landed back here with `?motive=connected|denied|error` —
 * see the callback route. Read once on mount and cleared from the URL, so a
 * refresh does not replay a stale banner.
 */
function useMotiveRedirectResult(): string | null {
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const motive = params.get('motive');
    if (motive) {
      setResult(motive);
      params.delete('motive');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
      window.history.replaceState(null, '', next);
    }
  }, []);
  return result;
}

const RESULT_MESSAGE: Record<string, { text: string; tone: 'ok' | 'warn' }> = {
  connected: { text: 'Motive is connected.', tone: 'ok' },
  denied: { text: 'The Motive connection was cancelled.', tone: 'warn' },
  error: { text: 'Something went wrong connecting Motive. Try again, or check the server log.', tone: 'warn' },
};

export function IntegrationsScreen() {
  const session = useSession();
  const orgs = useOrgs();
  const myRole = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canConnect = myRole === 'owner';

  const redirectResult = useMotiveRedirectResult();

  const items = useQuery({
    queryKey: ['integrations'],
    queryFn: () => request<{ items: BoardCredential[] }>('/v1/integrations'),
  });

  const connect = useMutation({
    mutationFn: () => request<{ url: string }>('/v1/integrations/motive/connect'),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const motive = items.data?.items.find((i) => i.board === 'motive');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl">Integrations</h1>
        <p className="mt-1 max-w-prose text-slate">
          Boards and ELDs connected to this account. Motive's own position
          reports will feed Track the same way a driver's check-in does,
          once the adapter that reads them is built.
        </p>
      </div>

      {redirectResult && RESULT_MESSAGE[redirectResult] && (
        <p
          className={`border-l-2 px-3 py-2 text-sm ${
            RESULT_MESSAGE[redirectResult]!.tone === 'ok'
              ? 'border-ok bg-ok-50 text-ok'
              : 'border-warn bg-warn-50 text-warn'
          }`}
        >
          {RESULT_MESSAGE[redirectResult]!.text}
        </p>
      )}

      <Card title="Motive">
        {items.isLoading ? (
          <p className="text-mute">Checking…</p>
        ) : motive ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Pill tone={STATUS_TONE[motive.status] ?? 'neutral'}>{motive.status}</Pill>
              {motive.lastVerifiedAt && (
                <span className="ml-2 text-sm text-mute">
                  connected {new Date(motive.lastVerifiedAt).toLocaleDateString()}
                </span>
              )}
              {motive.lastError && (
                <p className="mt-1 max-w-prose text-sm text-bad">{motive.lastError}</p>
              )}
            </div>
            {canConnect && (
              <button
                className="hq-btn hq-btn-ghost"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
              >
                Reconnect
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Empty>Not connected. Position reports from Motive-equipped trucks will use this once it is.</Empty>
            {canConnect ? (
              <button
                className="hq-btn hq-btn-brand"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
              >
                {connect.isPending ? 'Redirecting…' : 'Connect Motive'}
              </button>
            ) : (
              <span className="text-sm text-mute">Only an owner can connect an integration.</span>
            )}
          </div>
        )}
        <ErrorNote error={connect.error} />
      </Card>

      {items.data && items.data.items.filter((i) => i.board !== 'motive').length > 0 && (
        <Card title="Other connections">
          <ul className="space-y-2">
            {items.data.items
              .filter((i) => i.board !== 'motive')
              .map((i) => (
                <li key={i.id} className="flex items-center justify-between">
                  <span>{BOARD_LABEL[i.board] ?? i.board}</span>
                  <Pill tone={STATUS_TONE[i.status] ?? 'neutral'}>{i.status}</Pill>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
