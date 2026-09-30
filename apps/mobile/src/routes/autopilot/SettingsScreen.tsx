/**
 * Autopilot's settings on a phone: the mailbox it sends from, the master
 * switch, and how freely each kind of message may go out. Web's Settings tab
 * (`apps/web/src/routes/Autopilot.tsx`, `SettingsPanel`), which the app used
 * to send people to.
 *
 * The owner changes these (`canConfigureOutbound`, the same rule the API's
 * `requireRole` applies); a dispatcher sees how they're set. An accountant
 * never reaches this screen.
 *
 * Two things are deliberate:
 * - **Off is the loudest state.** The switch is what someone reaches for in a
 *   hurry, and "did it stop?" must be answerable at a glance. Turning it off
 *   asks first; turning it on needs a connected mailbox.
 * - **Only actions a loop actually drives are offered** (`available`).
 *   Offering the rest invites someone to configure something that does nothing.
 */

import {
  ACTION_COPY,
  ACTION_POSITIONS,
  actionTitle,
  canConfigureOutbound,
  evidenceView,
  mailboxOffered,
  positionAllowed,
  positionFor,
  previewReason,
  useMailbox,
  useOutboundEvidence,
  useOutboundSettings,
  useSendTestMessage,
  useSetActionPosition,
  useSetSendingEnabled,
  type OutboundEvidence,
  type OutboundSettingsResponse,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, ErrorNote, Note, Pill } from '../../components/ui.tsx';
import { successFeedback, tapFeedback } from '../../lib/haptics.ts';
import { StepUps } from './parts.tsx';

export function AutopilotSettingsScreen() {
  const role = useSession()?.role;
  const canSee = role === 'owner' || role === 'dispatcher';
  const canConfigure = canConfigureOutbound(role);
  const settings = useOutboundSettings({ enabled: canSee });
  const evidence = useOutboundEvidence({ enabled: canSee });
  const mailbox = useMailbox({ enabled: canSee });

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/autopilot" className="text-sm text-brand">
        ‹ Autopilot
      </Link>
      <h1 className="text-2xl">Autopilot settings</h1>

      {!canSee ? (
        <Note>Autopilot’s settings are for the owner and dispatchers.</Note>
      ) : (
        <>
          {!canConfigure && <Note>Only the owner can change these. You can see how they’re set.</Note>}
          <ErrorNote error={settings.error} />
          {settings.data && !settings.data.autopilotRunning && (
            <p className="hq-card bg-warn-50 px-4 py-3 text-sm text-warn shadow-none">
              Autopilot isn’t switched on for this HaulQ server yet, so nothing new is written until it is. Your choices are saved and apply
              when it is.
            </p>
          )}

          <Mailbox data={mailbox.data} loading={mailbox.isLoading} canConfigure={canConfigure} />
          {settings.data && (
            <>
              <SendingSwitch
                settings={settings.data}
                mailboxConnected={mailbox.data?.connected === true}
                mailboxAvailable={mailboxOffered(mailbox.data)}
                canConfigure={canConfigure}
              />
              <Actions settings={settings.data} evidence={evidence.data} canConfigure={canConfigure} />
            </>
          )}
          {settings.isLoading && <p className="text-sm text-mute">Loading…</p>}
        </>
      )}
    </div>
  );
}

/**
 * Where messages go out from. Connecting happens in Connected services,
 * through the in-app browser (M6), so this only says where it stands. On a
 * deployment with no mailbox provider it says so calmly, and points at
 * forwarding by email, which already works without one.
 */
function Mailbox({
  data,
  loading,
  canConfigure,
}: {
  data: ReturnType<typeof useMailbox>['data'];
  loading: boolean;
  canConfigure: boolean;
}) {
  // Hidden entirely while there's no mailbox provider on HaulQ's side.
  if (loading || !data || !mailboxOffered(data)) return null;

  return (
    <Card title="Your mailbox">
      <div className="flex items-center justify-between gap-3">
        <Pill tone={data.connected ? 'ok' : 'neutral'}>
          {data.connected ? 'connected' : data.status === 'pending' ? 'finishing…' : 'not connected'}
        </Pill>
        {canConfigure && (
          <Link to="/integrations" className="text-sm font-semibold text-brand">
            {data.connected ? 'Manage' : 'Connect'} ›
          </Link>
        )}
      </div>
      <p className="mt-2 text-sm text-slate">
        {data.connected
          ? 'Messages go out from your own work email, so brokers reply to you.'
          : 'Connect the work email you use with brokers. Nothing is sent just because it’s connected.'}
      </p>
    </Card>
  );
}

function SendingSwitch({
  settings,
  mailboxConnected,
  mailboxAvailable,
  canConfigure,
}: {
  settings: OutboundSettingsResponse;
  mailboxConnected: boolean;
  mailboxAvailable: boolean;
  canConfigure: boolean;
}) {
  const setSending = useSetSendingEnabled();
  const on = settings.sendingEnabled;

  return (
    <section className={`hq-card space-y-3 p-4 shadow-none ${on ? 'bg-ok-50' : 'bg-bad-50'}`}>
      <div>
        <p className={`text-lg font-semibold ${on ? 'text-ok' : 'text-bad'}`}>Sending is {on ? 'ON' : 'OFF'}</p>
        <p className="text-sm text-slate">
          {on
            ? 'Messages you approve, and anything set to send automatically, go out. Turn this off and nothing leaves, whatever else is set.'
            : mailboxConnected
              ? 'Nothing leaves your mailbox. Autopilot can still write messages for you to look at.'
              : mailboxAvailable
                ? 'Connect a mailbox first. Until then nothing can be sent.'
                : 'Sending from your own email isn’t available yet. Autopilot can still write messages for you to look at.'}
        </p>
      </div>
      {canConfigure && (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`hq-btn w-full ${on ? 'hq-btn-ghost text-bad' : 'hq-btn-primary'}`}
          disabled={setSending.isPending || (!on && !mailboxConnected)}
          onClick={() => {
            if (on && !window.confirm('Stop sending? Nothing will leave your mailbox until you turn it back on.')) return;
            tapFeedback();
            setSending.mutate(!on);
          }}
        >
          {setSending.isPending ? 'Saving…' : on ? 'Stop sending' : 'Turn sending on'}
        </button>
      )}
      <ErrorNote error={setSending.error} />
    </section>
  );
}

/**
 * One control per action, four positions: Off, Show me first, Ask me first,
 * Send automatically. A position above the action's ceiling is shown but
 * can't be picked, with the reason, so the limit is visible rather than
 * mysterious. The carrier's own history (marks on previews, what they did
 * with held drafts) is shown under each, since that's what the choice
 * should rest on.
 */
function Actions({
  settings,
  evidence,
  canConfigure,
}: {
  settings: OutboundSettingsResponse;
  evidence: Record<string, OutboundEvidence> | undefined;
  canConfigure: boolean;
}) {
  const setPosition = useSetActionPosition();
  const test = useSendTestMessage();
  const actions = settings.actions.filter((a) => a.available);

  return (
    <>
      <Card title="What Autopilot does">
        <div className="space-y-6">
          {actions.length === 0 && <p className="text-sm text-mute">Nothing to set up yet.</p>}
          {actions.map((action) => {
            const current = positionFor(settings, action.type);
            const ceiling = positionAllowed(action, 'auto');
            const history = evidenceView(action, current, evidence?.[action.type]);
            return (
              <div key={action.type} className="space-y-2">
                <div>
                  <p className="font-semibold">{actionTitle(action.type)}</p>
                  {ACTION_COPY[action.type]?.blurb && <p className="text-sm text-slate">{ACTION_COPY[action.type]!.blurb}</p>}
                </div>
                <div role="radiogroup" aria-label={actionTitle(action.type)} className="grid grid-cols-2 gap-1.5">
                  {ACTION_POSITIONS.map((p) => {
                    const allowed = positionAllowed(action, p.value);
                    const selected = current === p.value;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!canConfigure || !allowed.allowed || setPosition.isPending}
                        className={`min-h-11 rounded-[var(--radius-sm)] px-2 text-sm font-semibold ${
                          selected ? 'bg-ink text-white' : 'bg-wash text-slate'
                        } disabled:opacity-40 ${selected ? 'disabled:opacity-100' : ''}`}
                        onClick={() => {
                          successFeedback();
                          setPosition.mutate({ actionType: action.type, position: p.value });
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-sm text-mute">
                  {ACTION_POSITIONS.find((p) => p.value === current)?.help}
                  {!ceiling.allowed && ` ${ceiling.reason}`}
                </p>
                {history.summary && <p className="num text-sm text-slate">{history.summary}</p>}
                {history.progress && <p className="text-sm text-mute">{history.progress}</p>}
              </div>
            );
          })}
          <ErrorNote error={setPosition.error} />
        </div>
      </Card>

      <StepUps settings={settings} evidence={evidence} canConfigure={canConfigure} />

      {canConfigure && (
        <Card>
          <button type="button" className="hq-btn hq-btn-ghost w-full" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Sending…' : 'Send myself a test message'}
          </button>
          {test.data && (
            <p className={`mt-2 text-sm ${test.data.sent ? 'text-ok' : 'text-warn'}`}>
              {test.data.sent ? 'Sent. Check your inbox.' : `Not sent. ${previewReason(test.data.message)}`}
            </p>
          )}
          <div className="mt-2">
            <ErrorNote error={test.error} />
          </div>
        </Card>
      )}
    </>
  );
}
