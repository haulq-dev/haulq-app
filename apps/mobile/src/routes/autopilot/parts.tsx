/**
 * Pieces the Autopilot inbox and its message screen share.
 * `FEATURE_REQUESTS_PLAN.md` section 10.
 *
 * The wording comes from `@haulq/client` (`outbound.ts`), the same words the
 * web screen uses. A carrier never reads "shadow", "draft" or "act".
 */

import {
  actionTitle,
  messageAge,
  relatedLabel,
  stepUpOffers,
  useMarkOutbound,
  useSetActionPosition,
  type OutboundEvidence,
  type OutboundMessage,
  type OutboundSettingsResponse,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ErrorNote, Pill } from '../../components/ui.tsx';
import { successFeedback, tapFeedback } from '../../lib/haptics.ts';

/** One line about where a message stands, for the list. */
export function messageStatusPill(message: OutboundMessage) {
  switch (message.status) {
    case 'pending_approval':
      return <Pill tone="warn">Needs your OK</Pill>;
    case 'shadow':
      return message.verdict === 'right' ? (
        <Pill tone="ok">Marked right</Pill>
      ) : message.verdict === 'wrong' ? (
        <Pill tone="warn">Marked wrong</Pill>
      ) : (
        <Pill>Not looked at</Pill>
      );
    case 'sending':
      return <Pill>Sending…</Pill>;
    case 'sent':
      return <Pill tone="ok">Sent</Pill>;
    case 'failed':
      return <Pill tone="warn">Failed</Pill>;
    case 'rejected':
      return <Pill>Rejected</Pill>;
    case 'expired':
      return <Pill>Withdrawn</Pill>;
  }
}

/** A message in the list. Tapping opens it; nothing is approved from here. */
export function MessageRow({ message }: { message: OutboundMessage }) {
  const about = relatedLabel(message);
  return (
    <Link to="/autopilot/$messageId" params={{ messageId: message.id }} className="hq-card block space-y-1.5 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-mute">{actionTitle(message.actionType)}</span>
        <span className="text-xs text-mute">{messageAge(message.createdAt)}</span>
      </div>
      <p className="break-words font-semibold">{message.subject}</p>
      <p className="num break-all text-sm text-slate">To {message.toAddresses.join(', ')}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {messageStatusPill(message)}
        {about && <span className="text-xs text-mute">{about}</span>}
        {message.attachments.length > 0 && (
          <span className="text-xs text-mute">
            {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </Link>
  );
}

/**
 * Was this preview what they would have wanted sent? One tap for right; a few
 * optional words for wrong, because why is what tells us what to fix.
 */
export function MarkControls({ message }: { message: OutboundMessage }) {
  const mark = useMarkOutbound();
  const [explaining, setExplaining] = useState(false);
  const [note, setNote] = useState(message.verdictNote ?? '');

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-slate">Is this what you would have wanted sent?</p>
      <div className="flex gap-2">
        <button
          type="button"
          className={`hq-btn flex-1 ${message.verdict === 'right' ? 'hq-btn-primary' : 'hq-btn-ghost'}`}
          aria-pressed={message.verdict === 'right'}
          disabled={mark.isPending}
          onClick={() => {
            tapFeedback();
            setExplaining(false);
            mark.mutate({ id: message.id, verdict: 'right' });
          }}
        >
          Looks right
        </button>
        <button
          type="button"
          className={`hq-btn flex-1 ${message.verdict === 'wrong' ? 'hq-btn-primary' : 'hq-btn-ghost'}`}
          aria-pressed={message.verdict === 'wrong'}
          disabled={mark.isPending}
          onClick={() => setExplaining(true)}
        >
          Not right
        </button>
      </div>
      {explaining && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            mark.mutate(
              { id: message.id, verdict: 'wrong', ...(note.trim() ? { note: note.trim() } : {}) },
              { onSuccess: () => setExplaining(false) },
            );
          }}
        >
          <input
            className="hq-input"
            aria-label="What was wrong?"
            placeholder="What was wrong? (optional)"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className="hq-btn hq-btn-primary w-full" disabled={mark.isPending}>
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
 * "Ready to move up?" One offer per action the carrier's history supports,
 * with the count in front of the owner. Never applied on its own: the owner
 * taps it. Anyone else sees the offer and is told whose decision it is.
 */
export function StepUps({
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
        <div key={action.type} className="hq-card space-y-2 bg-ok-50 p-4 shadow-none">
          <p className="font-semibold text-ok">Ready to move up? {actionTitle(action.type)}</p>
          <p className="text-sm text-slate">{view.stepUp.reason}</p>
          {canConfigure ? (
            <button
              type="button"
              className="hq-btn hq-btn-primary w-full"
              disabled={setPosition.isPending}
              onClick={() => {
                successFeedback();
                setPosition.mutate({ actionType: action.type, position: view.stepUp.to });
              }}
            >
              {setPosition.isPending ? 'Saving…' : `Switch to “${view.stepUp.label}”`}
            </button>
          ) : (
            <p className="text-sm text-mute">The owner can switch this.</p>
          )}
        </div>
      ))}
      <ErrorNote error={setPosition.error} />
    </div>
  );
}
