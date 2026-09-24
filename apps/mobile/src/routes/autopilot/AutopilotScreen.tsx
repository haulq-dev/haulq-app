/**
 * Autopilot on the phone: what it wrote, for the people who approve it.
 * `FEATURE_REQUESTS_PLAN.md` section 10, S4a.
 *
 * An inbox, not a settings page. Setting Autopilot up (the mailbox, how freely
 * each kind of message may act) stays on the web. What lives here is the daily
 * job: read what it wrote, approve or reject what is waiting, tell it whether
 * its previews were right, and stop it if something looks wrong.
 *
 * **Previews are here as well as approvals.** A carrier starts with every
 * action on "Show me first", so for the first weeks nothing waits for an OK:
 * it is all previews. An approvals-only inbox would be empty exactly when
 * someone first opens it.
 *
 * **Nothing is approved from this list.** Each message opens on its own screen
 * with the whole text and its attachments; Approve is there.
 *
 * Stopping sending is here because it is what someone reaches for in a hurry.
 * Turning it back on is not: that stays on the web, where the mailbox is in
 * front of them. No plan, price or upgrade wording anywhere (Guideline 3.1.1).
 */

import {
  canConfigureOutbound,
  canReviewOutbound,
  groupMessages,
  useMailbox,
  useOutboundEvidence,
  useOutboundMessages,
  useOutboundSettings,
  useSetSendingEnabled,
  type OutboundMessage,
  type OutboundSettingsResponse,
} from '@haulq/client';
import { useEffect, useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Empty, ErrorNote } from '../../components/ui.tsx';
import { MessageRow, StepUps } from './parts.tsx';

/** How often an open screen looks again. Coming back to the app refreshes it as well (see `main.tsx`). */
const REFRESH_MS = 30_000;

type Section = 'approve' | 'preview' | 'history';

const SECTION_LABEL: Record<Section, string> = {
  approve: 'Needs your OK',
  preview: 'Previews',
  history: 'History',
};

export function AutopilotScreen() {
  const role = useSession()?.role;
  const canReview = canReviewOutbound(role);
  const isOwner = canConfigureOutbound(role);

  const settings = useOutboundSettings({ enabled: canReview });
  const messages = useOutboundMessages({ enabled: canReview, refetchMs: REFRESH_MS });
  const evidence = useOutboundEvidence({ enabled: canReview });
  // Owner and dispatcher can read the mailbox; the API refuses an accountant.
  const mailbox = useMailbox({ enabled: role === 'owner' || role === 'dispatcher' });

  const groups = groupMessages(messages.data ?? []);
  // Sent and everything that did not send, newest first, in one list: on a
  // phone that is what "History" is, and the reason is on each message.
  const history = [...groups.sent, ...groups.problems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lists: Record<Section, OutboundMessage[]> = { approve: groups.approve, preview: groups.preview, history };

  // Decided once, when the first messages arrive: what is waiting first, else
  // the previews, else the empty approvals. Re-deciding on every refresh would
  // move someone off the list they are reading.
  const [section, setSection] = useState<Section | null>(null);
  useEffect(() => {
    if (section !== null || !messages.data) return;
    setSection(groups.approve.length > 0 ? 'approve' : groups.preview.length > 0 ? 'preview' : 'approve');
  }, [section, messages.data, groups.approve.length, groups.preview.length]);
  const active: Section = section ?? 'approve';

  if (!canReview) {
    return (
      <div className="mx-auto max-w-md space-y-2 px-4 py-6">
        <h1 className="text-2xl">Autopilot</h1>
        <p className="text-slate">Autopilot is for the people who run the business side of the carrier.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <h1 className="text-2xl">Autopilot</h1>

      <SendingStatus settings={settings.data} isOwner={isOwner} />
      {isOwner && <SetupNote settings={settings.data} mailboxConnected={mailbox.data?.connected} mailboxKnown={!mailbox.isLoading} />}
      <ErrorNote error={settings.error ?? messages.error} />

      <div role="tablist" className="flex gap-1 rounded-[var(--radius-sm)] bg-card p-1 shadow-[inset_0_0_0_1px_var(--color-line)]">
        {(Object.keys(SECTION_LABEL) as Section[]).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={active === s}
            className={`min-h-10 flex-1 rounded-[var(--radius-sm)] px-2 text-sm font-semibold ${active === s ? 'bg-ink text-white' : 'text-slate'}`}
            onClick={() => setSection(s)}
          >
            {SECTION_LABEL[s]}
            {lists[s].length > 0 && <span className="num ml-1">{lists[s].length}</span>}
          </button>
        ))}
      </div>

      {active === 'preview' && (
        <>
          {groups.preview.length > 0 && (
            <p className="text-sm text-slate">
              These were written but not sent. Open one and tell it whether it is what you would have wanted. That is how you decide how much to
              trust it.
            </p>
          )}
          <StepUps settings={settings.data} evidence={evidence.data} canConfigure={isOwner} />
        </>
      )}

      {messages.isLoading ? (
        <p className="text-sm text-mute">Loading…</p>
      ) : lists[active].length === 0 ? (
        <Empty>{EMPTY[active]}</Empty>
      ) : (
        <div className="space-y-3">
          {lists[active].map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY: Record<Section, string> = {
  approve: 'Nothing is waiting for you. When Autopilot writes something that needs your OK, it will show up here.',
  preview: 'No previews yet. When an action is set to “Show me first”, what it would have sent shows up here without going anywhere.',
  history: 'Nothing has been sent yet.',
};

/**
 * The master switch, as far as a phone goes. Off is loud, because "did it
 * stop?" has to be answerable at a glance. The owner can stop it here; turning
 * it on stays on the web.
 */
function SendingStatus({ settings, isOwner }: { settings: OutboundSettingsResponse | undefined; isOwner: boolean }) {
  const setSending = useSetSendingEnabled();
  if (!settings) return null;

  if (!settings.sendingEnabled) {
    return (
      <div className="hq-card space-y-1 bg-bad-50 p-4 shadow-none">
        <p className="font-semibold text-bad">Sending from your mailbox is OFF</p>
        <p className="text-sm text-slate">
          Nothing leaves your mailbox. Autopilot can still write messages for you to look at.
          {isOwner && ' Turn it back on from HaulQ on the web.'}
        </p>
      </div>
    );
  }

  if (!isOwner) return null;
  return (
    <div className="hq-card flex items-center justify-between gap-3 p-4">
      <div>
        <p className="text-sm font-semibold text-ok">Sending from your mailbox is ON</p>
        <p className="text-xs text-mute">Stopping it holds everything, whatever else is set.</p>
      </div>
      <button
        type="button"
        className="hq-btn hq-btn-ghost text-bad"
        disabled={setSending.isPending}
        onClick={() => {
          if (window.confirm('Stop sending? Nothing will leave your mailbox until you turn it back on from HaulQ on the web.')) {
            setSending.mutate(false);
          }
        }}
      >
        {setSending.isPending ? 'Stopping…' : 'Stop sending'}
      </button>
      <ErrorNote error={setSending.error} />
    </div>
  );
}

/** What is left for the owner to do, and where. Setup is on the web; this only says so, with no link to follow. */
function SetupNote({
  settings,
  mailboxConnected,
  mailboxKnown,
}: {
  settings: OutboundSettingsResponse | undefined;
  mailboxConnected: boolean | undefined;
  mailboxKnown: boolean;
}) {
  if (!settings || !mailboxKnown) return null;
  const notRunning = !settings.autopilotRunning;
  const text = notRunning
    ? 'Autopilot is not switched on for this HaulQ server yet, so nothing new will be written until it is.'
    : mailboxConnected === false
      ? 'Connect your mailbox from HaulQ on the web to get Autopilot started.'
      : Object.keys(settings.configured).length === 0
        ? 'Choose what Autopilot should do from HaulQ on the web.'
        : null;
  if (!text) return null;
  return <p className="hq-card bg-warn-50 px-4 py-3 text-sm text-warn shadow-none">{text}</p>;
}
