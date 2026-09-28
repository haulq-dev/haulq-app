/**
 * Connected services: Motive (truck positions) and the mailbox (rate
 * confirmations in, Autopilot's email out). Web's `Integrations.tsx` plus the
 * mailbox part of web's Autopilot setup (MOBILE_PARITY_PLAN.md M6).
 *
 * **Connecting goes through the in-app browser**, never the WebView: Motive's
 * and Unipile's sign-in pages refuse to run inside an embedded WebView, the
 * same way Google sign-in does. The connect is started with `from: 'app'`, so
 * the API finishes it on its hand-back page, which reopens the app at
 * `ai.haulq.app://integrations?...`. `main.tsx` closes the browser and lands
 * here, and the result is read off the URL.
 *
 * If the person closes the browser themselves instead, `main.tsx` refreshes
 * this screen's queries on `browserFinished`, so a connect that did finish
 * still shows.
 *
 * Owner only for connect and disconnect, as the API requires. Motive is part
 * of HaulQ Track, which only some plans include. A carrier whose plan doesn't
 * is told so plainly, with no upgrade prompt (Guideline 3.1.1).
 */

import { Browser } from '@capacitor/browser';
import {
  canManageIntegrations,
  connectResult,
  useConnectMailbox,
  useConnectMotive,
  useDisconnectMailbox,
  useDisconnectMotive,
  useIntegrations,
  useMailbox,
  useOrgs,
  type ConnectResult,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, ErrorNote, Note, Pill } from '../../components/ui.tsx';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = { active: 'ok', failed: 'warn', revoked: 'warn', unverified: 'neutral' };

/** Read once from the URL the app was reopened at, then cleared, so going back doesn't replay it. */
function useReturnedResult(): ConnectResult | null {
  const [result] = useState(() => connectResult(window.location.search));
  useEffect(() => {
    if (result) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [result]);
  return result;
}

async function openInBrowser(url: string) {
  await Browser.open({ url, presentationStyle: 'popover' });
}

export function IntegrationsScreen() {
  const session = useSession();
  const isOwner = canManageIntegrations(session?.role);
  const result = useReturnedResult();

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <h1 className="text-2xl">Connected services</h1>

      {result && (
        <p className={`hq-card px-3 py-2.5 text-sm shadow-none ${result.ok ? 'bg-ok-50 text-ok' : 'bg-warn-50 text-warn'}`} role="status">
          {result.text}
        </p>
      )}

      <Motive isOwner={isOwner} justConnected={result?.provider === 'motive' && result.ok} />
      <Mailbox isOwner={isOwner} justConnected={result?.provider === 'mailbox' && result.ok} />
      {!isOwner && <p className="text-sm text-mute">Only an owner can connect or disconnect these.</p>}
    </div>
  );
}

function Motive({ isOwner, justConnected }: { isOwner: boolean; justConnected: boolean }) {
  const session = useSession();
  const orgs = useOrgs();
  const plan = orgs.data?.items.find((o) => o.id === session?.orgId)?.plan;
  const integrations = useIntegrations();
  const connect = useConnectMotive({ from: 'app' });
  const disconnect = useDisconnectMotive();
  const [confirming, setConfirming] = useState(false);

  const motive = integrations.data?.items.find((i) => i.board === 'motive');
  const configured = integrations.data?.deployment.motive.configured ?? true;

  return (
    <Card title="Motive">
      <p className="mb-3 text-sm text-slate">Truck positions from your ELD, so tracking and ETAs update on their own.</p>
      <ErrorNote error={integrations.error} />
      {integrations.isLoading && <p className="text-sm text-mute">Checking…</p>}

      {motive ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Pill tone={STATUS_TONE[motive.status] ?? 'neutral'}>{motive.status === 'active' ? 'connected' : motive.status}</Pill>
            {motive.lastVerifiedAt && (
              <span className="text-sm text-mute">since {new Date(motive.lastVerifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            )}
          </div>
          {motive.lastError && <p className="text-sm text-bad">{motive.lastError}</p>}
          {(justConnected || motive.status === 'active') && (
            <Link to="/trucks" className="block text-sm text-brand underline">
              Match trucks to Motive vehicles
            </Link>
          )}
        </div>
      ) : (
        integrations.isSuccess && <p className="text-sm text-mute">Not connected.</p>
      )}

      {integrations.isSuccess && !configured && <Note>Motive isn't set up on HaulQ's side yet.</Note>}
      {integrations.isSuccess && configured && plan !== 'fleet' && !motive && (
        <Note>Motive tracking isn't included in your carrier's HaulQ plan.</Note>
      )}

      {isOwner && configured && (plan === 'fleet' || motive) && (
        <div className="mt-3 space-y-2">
          {(!motive || motive.status !== 'active') && (
            <button
              type="button"
              className="hq-btn hq-btn-primary w-full"
              disabled={connect.isPending}
              onClick={() => connect.mutate(undefined, { onSuccess: ({ url }) => void openInBrowser(url) })}
            >
              {connect.isPending ? 'Opening Motive…' : motive ? 'Reconnect Motive' : 'Connect Motive'}
            </button>
          )}
          {motive?.status === 'active' && !confirming && (
            <button type="button" className="w-full py-2 text-sm text-bad" onClick={() => setConfirming(true)}>
              Disconnect Motive
            </button>
          )}
          {confirming && (
            <div className="space-y-2">
              <p className="text-sm text-slate">Positions stop updating from Motive. Trucks keep their matches for when you reconnect.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="hq-btn flex-1 bg-bad text-white"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate(undefined, { onSuccess: () => setConfirming(false) })}
                >
                  Disconnect
                </button>
                <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setConfirming(false)}>
                  Keep
                </button>
              </div>
            </div>
          )}
          <ErrorNote error={connect.error ?? disconnect.error} />
        </div>
      )}
    </Card>
  );
}

/**
 * The work inbox. Connecting only lets HaulQ read it (rate confirmations
 * arrive on their own); sending from it is a separate switch that starts off
 * and is reset on every reconnect (see `mailbox.ts` on the API).
 */
function Mailbox({ isOwner, justConnected }: { isOwner: boolean; justConnected: boolean }) {
  const role = useSession()?.role;
  const canRead = role === 'owner' || role === 'dispatcher';
  // Unipile confirms the account by a separate call that can land after the
  // browser comes back, so keep looking for a little while it says pending.
  const [watching, setWatching] = useState(justConnected);
  const mailbox = useMailbox({ enabled: canRead, refetchMs: watching ? 3000 : false });
  const connect = useConnectMailbox({ from: 'app' });
  const disconnect = useDisconnectMailbox();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!watching) return;
    if (mailbox.data?.connected) setWatching(false);
    const stop = setTimeout(() => setWatching(false), 60_000);
    return () => clearTimeout(stop);
  }, [watching, mailbox.data?.connected]);

  if (!canRead) return null;
  const m = mailbox.data;

  return (
    <Card title="Mailbox">
      <p className="mb-3 text-sm text-slate">
        Your work email. Rate confirmations brokers send you come into Documents on their own, and Autopilot can draft
        replies from it.
      </p>
      <ErrorNote error={mailbox.error} />
      {m && (
        <div className="flex items-center gap-2">
          <Pill tone={m.connected ? 'ok' : m.status === 'pending' ? 'neutral' : 'warn'}>
            {m.connected ? 'connected' : m.status === 'pending' ? 'finishing…' : m.status.replace(/_/g, ' ')}
          </Pill>
          {m.connected && m.provider && <span className="text-sm text-mute">{m.provider}</span>}
        </div>
      )}

      {isOwner && m && (
        <div className="mt-3 space-y-2">
          {!m.connected && (
            <button
              type="button"
              className="hq-btn hq-btn-primary w-full"
              disabled={connect.isPending}
              onClick={() => connect.mutate(undefined, { onSuccess: ({ url }) => void openInBrowser(url) })}
            >
              {connect.isPending ? 'Opening…' : 'Connect your mailbox'}
            </button>
          )}
          {m.connected && !confirming && (
            <button type="button" className="w-full py-2 text-sm text-bad" onClick={() => setConfirming(true)}>
              Disconnect mailbox
            </button>
          )}
          {confirming && (
            <div className="space-y-2">
              <p className="text-sm text-slate">Rate confirmations stop arriving from it, and Autopilot stops sending.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="hq-btn flex-1 bg-bad text-white"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate(undefined, { onSuccess: () => setConfirming(false) })}
                >
                  Disconnect
                </button>
                <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setConfirming(false)}>
                  Keep
                </button>
              </div>
            </div>
          )}
          <ErrorNote error={connect.error ?? disconnect.error} />
        </div>
      )}
    </Card>
  );
}
