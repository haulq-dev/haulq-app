/**
 * Autopilot: review what the system drafted, and control how freely it may
 * send. `FEATURE_REQUESTS_PLAN.md` section 9.
 *
 * Two jobs that should not be designed as one. *Reviewing* (approve, reject,
 * look back) is a daily job for owner, dispatcher and accountant. *Setting up*
 * (mailbox, the master switch, how freely each action may act) is the owner's,
 * a few times. They share a screen and a tab bar, and nothing else.
 *
 * The copy rule from the plan holds throughout: a carrier never reads
 * "shadow", "draft" or "act". The words describe what happens to *them*.
 * The wording lives in `@haulq/client` (`outbound.ts`) so mobile says the
 * same things.
 */

import {
  ACTION_COPY,
  ACTION_POSITIONS,
  actionTitle,
  attachmentPath,
  canConfigureOutbound,
  canReviewOutbound,
  defaultTab,
  evidenceView,
  fileSize,
  firstRunSteps,
  groupMessages,
  messageAge,
  positionAllowed,
  positionFor,
  previewReason,
  problemReason,
  relatedLabel,
  REVIEW_TAB_LABEL,
  stepUpOffers,
  useApiClient,
  useApproveOutbound,
  useConnectMailbox,
  useDisconnectMailbox,
  useMailbox,
  useMarkOutbound,
  useOutboundEvidence,
  useOutboundMessages,
  useOutboundSettings,
  useRejectOutbound,
  useSendTestMessage,
  useSetActionPosition,
  useSetSendingEnabled,
  type OutboundEvidence,
  type OutboundMessage,
  type OutboundSettingsResponse,
  type ReviewTab,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';

/** How often an open screen looks again. A draft appearing while someone is watching should not need a refresh. */
const REFRESH_MS = 30_000;
/** After coming back from connecting a mailbox, how long to keep asking whether it has landed. */
const MAILBOX_POLL_MS = 60_000;

/** The redirect back from connecting a mailbox carries `?mailbox=connected|denied`. Read once, then cleared so a refresh does not replay it. */
function useMailboxRedirect(): 'connected' | 'denied' | null {
  const [result] = useState<'connected' | 'denied' | null>(() => {
    const value = new URLSearchParams(window.location.search).get('mailbox');
    return value === 'connected' || value === 'denied' ? value : null;
  });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('mailbox')) return;
    params.delete('mailbox');
    window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
  }, []);
  return result;
}

export function AutopilotScreen() {
  const session = useSession();
  const orgs = useOrgs();
  const role = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canReview = canReviewOutbound(role);
  // Owner sets it up; a dispatcher can look at it. An accountant has no use for it.
  const canSeeSettings = role === 'owner' || role === 'dispatcher';
  const canConfigure = canConfigureOutbound(role);

  const redirect = useMailboxRedirect();
  const [pollUntil] = useState(() => (redirect === 'connected' ? Date.now() + MAILBOX_POLL_MS : 0));

  const settings = useOutboundSettings({ enabled: canReview });
  const messages = useOutboundMessages({ enabled: canReview, refetchMs: REFRESH_MS });
  const evidence = useOutboundEvidence({ enabled: canReview });
  const mailbox = useMailbox({
    enabled: canSeeSettings,
    // Unipile confirms the account by a separate server call that can land
    // after the browser is back, so the first read may still say "pending".
    refetchMs: pollUntil > Date.now() ? 3000 : false,
  });

  const groups = groupMessages(messages.data ?? []);

  // Decided once, when the first data arrives. Re-deciding on every refetch
  // would move someone off the tab they are reading the moment a list changes.
  const [tab, setTab] = useState<ReviewTab | null>(null);
  useEffect(() => {
    if (tab !== null || !settings.data || !messages.data) return;
    setTab(
      defaultTab({
        pending: groups.approve.length,
        settings: settings.data,
        returningFromMailbox: redirect !== null,
        canConfigure: canSeeSettings,
      }),
    );
  }, [tab, settings.data, messages.data, groups.approve.length, redirect, canSeeSettings]);

  if (orgs.isLoading) return <p className="text-mute">Loading…</p>;
  if (!canReview) {
    return (
      <div className="space-y-2">
        <h1 className="text-3xl">Autopilot</h1>
        <p className="text-slate">Autopilot is for the people who run the business side of the carrier. Your role does not include it.</p>
      </div>
    );
  }

  const tabs: ReviewTab[] = canSeeSettings ? ['approve', 'preview', 'sent', 'problems', 'settings'] : ['approve', 'preview', 'sent', 'problems'];
  const active: ReviewTab = tab ?? 'approve';
  const counts: Record<Exclude<ReviewTab, 'settings'>, number> = {
    approve: groups.approve.length,
    preview: groups.preview.length,
    sent: groups.sent.length,
    problems: groups.problems.length,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl">Autopilot</h1>
        <p className="mt-1 max-w-prose text-slate">
          The routine follow-up after a load is delivered — invoicing the broker and chasing what is late — written for you.
          Nothing goes out unless you have said it may.
        </p>
      </div>

      {settings.data && !settings.data.autopilotRunning && (
        <p className="border-l-2 border-warn bg-warn-50 px-3 py-2 text-sm text-warn">
          Autopilot is not switched on for this HaulQ server yet, so nothing new will be written until it is. Your choices are saved and will
          apply when it is.
        </p>
      )}

      <ErrorNote error={settings.error ?? messages.error} />

      {canConfigure && <FirstRun settings={settings.data} messages={messages.data ?? []} mailboxConnected={mailbox.data?.connected} onGoToSettings={() => setTab('settings')} />}

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={active === t}
            className={`field-label border-b-2 px-3 py-2 ${active === t ? 'border-brand text-ink' : 'border-transparent text-mute hover:text-ink'}`}
            onClick={() => setTab(t)}
          >
            {REVIEW_TAB_LABEL[t]}
            {t !== 'settings' && counts[t] > 0 && (
              <span className={`num ml-1.5 px-1.5 text-xs ${t === 'approve' ? 'bg-brand text-white' : t === 'problems' ? 'bg-bad text-white' : 'bg-wash text-slate'}`}>{counts[t]}</span>
            )}
          </button>
        ))}
      </div>

      {messages.isLoading && active !== 'settings' && <p className="text-mute">Loading…</p>}

      {active === 'approve' && (
        <MessageList
          loading={messages.isLoading}
          messages={groups.approve}
          empty="Nothing is waiting for you. When Autopilot writes something that needs your OK, it will appear here and you will get an email."
          render={(m) => <ApprovalCard key={m.id} message={m} sendingOn={settings.data?.sendingEnabled ?? true} />}
        />
      )}
      {active === 'preview' && (
        <div className="space-y-4">
          {groups.preview.length > 0 && (
            <p className="max-w-prose text-sm text-slate">
              These were written but not sent. Tell it whether each one is what you would have wanted. That is how you decide how much to trust it.
            </p>
          )}
          <StepUps settings={settings.data} evidence={evidence.data} canConfigure={canConfigure} />
          <MessageList
            loading={messages.isLoading}
            messages={groups.preview}
            empty="No previews. When an action is set to “Show me first”, what it would have sent shows up here without going anywhere."
            render={(m) => <MessageCard key={m.id} message={m} note={previewReason(m)} actions={<MarkControls message={m} />} />}
          />
        </div>
      )}
      {active === 'sent' && (
        <MessageList
          loading={messages.isLoading}
          messages={groups.sent}
          empty="Nothing has been sent yet."
          render={(m) => <MessageCard key={m.id} message={m} note={m.status === 'sending' ? 'Sending…' : `Sent ${m.sentAt ? messageAge(m.sentAt) : ''}`.trim()} tone="ok" />}
        />
      )}
      {active === 'problems' && (
        <MessageList
          loading={messages.isLoading}
          messages={groups.problems}
          empty="No problems. Anything that failed to send, or that you rejected, appears here."
          render={(m) => <MessageCard key={m.id} message={m} note={problemReason(m)} tone="warn" />}
        />
      )}
      {active === 'settings' && canSeeSettings && (
        <SettingsPanel
          settings={settings.data}
          evidence={evidence.data}
          mailbox={mailbox.data}
          mailboxLoading={mailbox.isLoading}
          redirect={redirect}
          canConfigure={canConfigure}
        />
      )}
    </div>
  );
}

// --- the checklist -----------------------------------------------------------------

function FirstRun({
  settings,
  messages,
  mailboxConnected,
  onGoToSettings,
}: {
  settings: OutboundSettingsResponse | undefined;
  messages: OutboundMessage[];
  mailboxConnected: boolean | undefined;
  onGoToSettings: () => void;
}) {
  if (!settings) return null;
  const steps = firstRunSteps({ mailbox: mailboxConnected === undefined ? undefined : { connected: mailboxConnected }, settings, messages });
  if (steps.every((s) => s.done)) return null;
  return (
    <Card title="Getting started">
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-3 text-sm">
            <span className={`num flex h-6 w-6 items-center justify-center border ${s.done ? 'border-ok bg-ok-50 text-ok' : 'border-line text-mute'}`} aria-hidden>
              {s.done ? '✓' : i + 1}
            </span>
            <span className={s.done ? 'text-mute line-through' : 'text-ink'}>{s.label}</span>
          </li>
        ))}
      </ol>
      <button type="button" className="hq-btn hq-btn-ghost mt-4" onClick={onGoToSettings}>
        Open settings
      </button>
    </Card>
  );
}

// --- messages ------------------------------------------------------------------------

function MessageList({ messages, loading, empty, render }: { messages: OutboundMessage[]; loading: boolean; empty: string; render: (m: OutboundMessage) => React.ReactNode }) {
  // Not "nothing here" until it has actually looked.
  if (loading) return null;
  if (messages.length === 0) return <Empty>{empty}</Empty>;
  return <div className="space-y-4">{messages.map(render)}</div>;
}

/** Opens an attachment in a new tab. Fetched with the tenant header, so it cannot be a plain link. */
function AttachmentChip({ attachment }: { attachment: OutboundMessage['attachments'][number] }) {
  const client = useApiClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    // Opened before the fetch, while the click still counts: a window opened
    // after an await is what a popup blocker stops.
    const tab = window.open('', '_blank');
    setBusy(true);
    setError(null);
    try {
      const blob = await client.requestBlob(attachmentPath(attachment));
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col">
      <button type="button" className="hq-btn hq-btn-ghost py-1 text-xs" disabled={busy} onClick={() => void open()}>
        {attachment.filename}
        {attachment.byteSize !== null && <span className="num font-normal text-mute">{fileSize(attachment.byteSize)}</span>}
      </button>
      {error !== null && <ErrorNote error={error} />}
    </span>
  );
}

function MessageCard({
  message,
  note,
  tone = 'neutral',
  actions,
  error,
}: {
  message: OutboundMessage;
  note?: string | undefined;
  tone?: 'ok' | 'warn' | 'neutral';
  actions?: React.ReactNode;
  error?: unknown;
}) {
  const about = relatedLabel(message);
  return (
    <section className="border border-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={tone}>{actionTitle(message.actionType)}</Pill>
          <span className="text-sm text-mute">{messageAge(message.createdAt)}</span>
        </div>
        {about && message.relatedType === 'load' && message.relatedId ? (
          <Link to="/loads/$loadId" params={{ loadId: message.relatedId }} className="text-sm text-brand underline">
            {about}
          </Link>
        ) : (
          about && <span className="text-sm text-mute">{about}</span>
        )}
      </header>
      <div className="space-y-3 p-5">
        <div>
          <span className="field-label text-mute">To </span>
          <span className="num break-all text-sm">{message.toAddresses.join(', ')}</span>
        </div>
        <p className="break-words font-semibold">{message.subject}</p>
        <p className="whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-sm text-slate">{message.body}</p>
        {message.attachments.length > 0 && (
          <div className="flex flex-wrap items-start gap-2" aria-label="Attachments">
            {message.attachments.map((a) => (
              <AttachmentChip key={`${a.kind}:${a.refId}`} attachment={a} />
            ))}
          </div>
        )}
        {note && (
          <p className={`text-sm ${tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-mute'}`}>{note}</p>
        )}
        <ErrorNote error={error} />
        {actions}
      </div>
    </section>
  );
}

function ApprovalCard({ message, sendingOn }: { message: OutboundMessage; sendingOn: boolean }) {
  const approve = useApproveOutbound();
  const reject = useRejectOutbound();
  const busy = approve.isPending || reject.isPending;
  return (
    <MessageCard
      message={message}
      error={approve.error ?? reject.error}
      note={sendingOn ? undefined : 'Sending from your mailbox is switched off, so this cannot be approved right now. The owner can turn it on in Settings.'}
      actions={
        <div className="flex flex-wrap gap-2">
          <button type="button" className="hq-btn hq-btn-brand" disabled={busy || !sendingOn} onClick={() => approve.mutate(message.id)}>
            {approve.isPending ? 'Sending…' : 'Approve and send'}
          </button>
          <button type="button" className="hq-btn hq-btn-ghost" disabled={busy} onClick={() => reject.mutate(message.id)}>
            {reject.isPending ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      }
    />
  );
}

// --- was it right? --------------------------------------------------------------------

/**
 * The verdict on a preview. "Looks right" is one tap, because most will be and
 * a chore nobody finishes is no evidence at all. "Not right" asks for a few
 * words, optional, because *why* is what tells us what to fix.
 */
function MarkControls({ message }: { message: OutboundMessage }) {
  const mark = useMarkOutbound();
  const [explaining, setExplaining] = useState(false);
  const [note, setNote] = useState(message.verdictNote ?? '');

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="field-label text-mute">Is this what you would have wanted sent?</span>
        <button
          type="button"
          className={`hq-btn ${message.verdict === 'right' ? 'hq-btn-primary' : 'hq-btn-ghost'}`}
          aria-pressed={message.verdict === 'right'}
          disabled={mark.isPending}
          onClick={() => {
            setExplaining(false);
            mark.mutate({ id: message.id, verdict: 'right' });
          }}
        >
          Looks right
        </button>
        <button
          type="button"
          className={`hq-btn ${message.verdict === 'wrong' ? 'hq-btn-primary' : 'hq-btn-ghost'}`}
          aria-pressed={message.verdict === 'wrong'}
          disabled={mark.isPending}
          onClick={() => setExplaining(true)}
        >
          Not right
        </button>
      </div>
      {explaining && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            mark.mutate(
              { id: message.id, verdict: 'wrong', ...(note.trim() ? { note: note.trim() } : {}) },
              { onSuccess: () => setExplaining(false) },
            );
          }}
        >
          <input
            className="hq-input min-w-0 flex-1"
            aria-label="What was wrong?"
            placeholder="What was wrong? (optional)"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className="hq-btn hq-btn-primary" disabled={mark.isPending}>
            {mark.isPending ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
      {!explaining && message.verdict === 'wrong' && message.verdictNote && (
        <p className="text-sm text-warn">You said: {message.verdictNote}</p>
      )}
      <ErrorNote error={mark.error} />
    </div>
  );
}

/**
 * "Ready to move up?" One offer per action the history supports, with the
 * count that supports it in front of the owner. Never applied on its own: a
 * carrier's history is a reason to offer, and the decision is theirs.
 */
function StepUps({
  settings,
  evidence,
  canConfigure,
}: {
  settings: OutboundSettingsResponse | undefined;
  evidence: Record<string, OutboundEvidence> | undefined;
  canConfigure: boolean;
}) {
  const setPosition = useSetActionPosition();
  const offers = stepUpOffers(settings, evidence);
  if (offers.length === 0) return null;

  return (
    <div className="space-y-3">
      {offers.map(({ action, view }) => (
        <div key={action.type} className="border-l-2 border-ok bg-ok-50 px-4 py-3">
          <p className="font-semibold text-ok">Ready to move up? {actionTitle(action.type)}</p>
          <p className="mt-1 text-sm text-slate">{view.stepUp.reason}</p>
          {canConfigure ? (
            <button
              type="button"
              className="hq-btn hq-btn-primary mt-3"
              disabled={setPosition.isPending}
              onClick={() => setPosition.mutate({ actionType: action.type, position: view.stepUp.to })}
            >
              {setPosition.isPending ? 'Saving…' : `Switch to “${view.stepUp.label}”`}
            </button>
          ) : (
            <p className="mt-2 text-sm text-mute">The owner can switch this in Settings.</p>
          )}
        </div>
      ))}
      <ErrorNote error={setPosition.error} />
    </div>
  );
}

// --- settings -----------------------------------------------------------------------

function SettingsPanel({
  settings,
  evidence,
  mailbox,
  mailboxLoading,
  redirect,
  canConfigure,
}: {
  settings: OutboundSettingsResponse | undefined;
  evidence: Record<string, OutboundEvidence> | undefined;
  mailbox: ReturnType<typeof useMailbox>['data'];
  mailboxLoading: boolean;
  redirect: 'connected' | 'denied' | null;
  canConfigure: boolean;
}) {
  if (!settings) return <p className="text-mute">Loading…</p>;
  return (
    <div className="space-y-6">
      {!canConfigure && <p className="text-sm text-mute">Only the owner can change these. You can see how they are set.</p>}
      <MailboxCard mailbox={mailbox} loading={mailboxLoading} redirect={redirect} canConfigure={canConfigure} />
      <SendingSwitch settings={settings} mailboxConnected={mailbox?.connected === true} canConfigure={canConfigure} />
      <ActionsCard settings={settings} evidence={evidence} canConfigure={canConfigure} />
    </div>
  );
}

function MailboxCard({
  mailbox,
  loading,
  redirect,
  canConfigure,
}: {
  mailbox: ReturnType<typeof useMailbox>['data'];
  loading: boolean;
  redirect: 'connected' | 'denied' | null;
  canConfigure: boolean;
}) {
  const connect = useConnectMailbox();
  const disconnect = useDisconnectMailbox();
  const connected = mailbox?.connected === true;
  // Back from the provider but not confirmed yet: say so rather than "not connected".
  const finishing = !connected && (mailbox?.status === 'pending' || redirect === 'connected');

  return (
    <Card title="Your mailbox">
      <div className="space-y-3">
        {redirect === 'denied' && (
          <p className="border-l-2 border-warn bg-warn-50 px-3 py-2 text-sm text-warn">The connection was cancelled, so nothing changed.</p>
        )}
        {loading ? (
          <p className="text-mute">Checking…</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <Pill tone={connected ? 'ok' : 'neutral'}>{connected ? 'Connected' : finishing ? 'Finishing up…' : 'Not connected'}</Pill>
              <p className="max-w-prose text-sm text-slate">
                {connected
                  ? 'Messages go out from your own work email, so brokers reply to you. Connecting also lets HaulQ read rate confirmations you receive.'
                  : finishing
                    ? 'Waiting for your email provider to confirm. This usually takes a few seconds.'
                    : 'Connect the work email you use with brokers. Nothing is sent just because it is connected.'}
              </p>
            </div>
            {canConfigure && (
              <div className="flex gap-2">
                {!connected && (
                  <button
                    type="button"
                    className="hq-btn hq-btn-brand"
                    disabled={connect.isPending}
                    onClick={() => connect.mutate(undefined, { onSuccess: (data) => (window.location.href = data.url) })}
                  >
                    {connect.isPending ? 'Opening…' : finishing ? 'Connect again' : 'Connect mailbox'}
                  </button>
                )}
                {connected && (
                  <button
                    type="button"
                    className="hq-btn hq-btn-ghost text-bad"
                    disabled={disconnect.isPending}
                    onClick={() => {
                      if (window.confirm('Disconnect your mailbox? Autopilot will stop sending, and HaulQ will stop reading it for rate confirmations.')) disconnect.mutate();
                    }}
                  >
                    {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <ErrorNote error={connect.error ?? disconnect.error} />
      </div>
    </Card>
  );
}

/**
 * The master switch. Off is the loudest state on the page, because this is the
 * control someone reaches for in a hurry, and "did it stop?" must be answerable
 * at a glance.
 */
function SendingSwitch({ settings, mailboxConnected, canConfigure }: { settings: OutboundSettingsResponse; mailboxConnected: boolean; canConfigure: boolean }) {
  const setSending = useSetSendingEnabled();
  const on = settings.sendingEnabled;
  return (
    <section className={`border-2 p-5 ${on ? 'border-ok bg-ok-50' : 'border-bad bg-bad-50'}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className={`text-xl ${on ? 'text-ok' : 'text-bad'}`}>Sending from your mailbox is {on ? 'ON' : 'OFF'}</h2>
          <p className="mt-1 max-w-prose text-sm text-slate">
            {on
              ? 'Messages you have approved, and anything set to send automatically, go out. Turn this off and nothing leaves, whatever else is set.'
              : mailboxConnected
                ? 'Nothing leaves your mailbox. Autopilot can still write messages for you to look at.'
                : 'Connect a mailbox first. Until then nothing can be sent.'}
          </p>
        </div>
        {canConfigure && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`hq-btn ${on ? 'hq-btn-ghost' : 'hq-btn-primary'}`}
            disabled={setSending.isPending || (!on && !mailboxConnected)}
            onClick={() => setSending.mutate(!on)}
          >
            {setSending.isPending ? 'Saving…' : on ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
      <div className="mt-3">
        <ErrorNote error={setSending.error} />
      </div>
    </section>
  );
}

function ActionsCard({
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
  // Only what a loop actually drives today: offering the rest invites someone
  // to configure something that does nothing.
  const actions = settings.actions.filter((a) => a.available);

  return (
    <Card title="What Autopilot does">
      <div className="space-y-6">
        {actions.map((action) => {
          const current = positionFor(settings, action.type);
          const ceiling = positionAllowed(action, 'auto');
          const history = evidenceView(action, current, evidence?.[action.type]);
          return (
            <div key={action.type} className="space-y-2">
              <div>
                <h3 className="font-semibold">{actionTitle(action.type)}</h3>
                <p className="max-w-prose text-sm text-slate">{ACTION_COPY[action.type]?.blurb}</p>
              </div>
              <div role="radiogroup" aria-label={actionTitle(action.type)} className="flex flex-wrap gap-1">
                {ACTION_POSITIONS.map((p) => {
                  const allowed = positionAllowed(action, p.value);
                  const selected = current === p.value;
                  return (
                    <button
                      key={p.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={allowed.allowed ? p.help : allowed.reason}
                      disabled={!canConfigure || !allowed.allowed || setPosition.isPending}
                      className={`hq-btn ${selected ? 'hq-btn-primary' : 'hq-btn-ghost'}`}
                      onClick={() => setPosition.mutate({ actionType: action.type, position: p.value })}
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
        <StepUps settings={settings} evidence={evidence} canConfigure={canConfigure} />

        {canConfigure && (
          <div className="border-t border-line pt-4">
            <button type="button" className="hq-btn hq-btn-ghost" disabled={test.isPending} onClick={() => test.mutate()}>
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
          </div>
        )}
      </div>
    </Card>
  );
}
