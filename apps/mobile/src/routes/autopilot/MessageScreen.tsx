/**
 * One message Autopilot wrote: the whole text, what is attached, and what a
 * person can do with it. `FEATURE_REQUESTS_PLAN.md` section 10, S4a.
 *
 * This is where Approve lives, not the list, so nothing is sent in a person's
 * name without its full text and attachments on screen. The actions are a
 * sticky bar above the tab bar, inside thumb reach however long the message.
 *
 * What a person can do depends on where it stands:
 *  - waiting for an OK: approve and send, or reject
 *  - a preview: mark it right or wrong
 *  - anything else: read it, with what happened
 *
 * The message comes from the list the inbox already loaded (the API has no
 * single-message read), so opening one straight from a notification later
 * costs one list fetch and works the same.
 */

import {
  actionTitle,
  attachmentPath,
  canReviewOutbound,
  fileSize,
  messageAge,
  previewReason,
  problemReason,
  useApproveOutbound,
  useOutboundMessages,
  useOutboundSettings,
  useRejectOutbound,
  type OutboundMessage,
} from '@haulq/client';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { DocumentPreview } from '../../components/DocumentPreview.tsx';
import { Card, ErrorNote } from '../../components/ui.tsx';
import { successFeedback } from '../../lib/haptics.ts';
import { MarkControls, messageStatusPill } from './parts.tsx';

export function MessageScreen() {
  const { messageId } = useParams({ from: '/autopilot/$messageId' });
  const role = useSession()?.role;
  const canReview = canReviewOutbound(role);
  const messages = useOutboundMessages({ enabled: canReview });
  const settings = useOutboundSettings({ enabled: canReview });
  const message = messages.data?.find((m) => m.id === messageId);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/autopilot" className="text-sm text-brand">
        ‹ Autopilot
      </Link>
      {messages.isError && <ErrorNote error={messages.error} />}
      {messages.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {messages.isSuccess && !message && (
        <p className="text-sm text-slate">That message is no longer here. It may be older than the latest hundred, or belong to another carrier.</p>
      )}
      {message && <Body message={message} sendingOn={settings.data?.sendingEnabled ?? true} />}
    </div>
  );
}

function Body({ message, sendingOn }: { message: OutboundMessage; sendingOn: boolean }) {
  const approve = useApproveOutbound();
  const reject = useRejectOutbound();
  const busy = approve.isPending || reject.isPending;
  const waiting = message.status === 'pending_approval';

  return (
    <>
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl">{actionTitle(message.actionType)}</h1>
          {messageStatusPill(message)}
        </div>
        <p className="text-sm text-mute">{messageAge(message.createdAt)}</p>
      </header>

      <Card>
        <div className="space-y-3">
          <p className="num break-all text-sm text-slate">To {message.toAddresses.join(', ')}</p>
          <p className="break-words font-semibold">{message.subject}</p>
          <p className="whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-sm text-slate">{message.body}</p>
        </div>
      </Card>

      {message.relatedType === 'load' && message.relatedId && (
        <Link to="/loads/$loadId" params={{ loadId: message.relatedId }} className="hq-card block p-4 text-sm font-semibold text-brand">
          Open the load ›
        </Link>
      )}

      {message.attachments.length > 0 && <Attachments message={message} />}

      {message.status === 'shadow' && (
        <Card title="Your verdict">
          <p className="mb-3 text-sm text-mute">{previewReason(message)}</p>
          <MarkControls message={message} />
        </Card>
      )}

      {!waiting && message.status !== 'shadow' && <Outcome message={message} />}

      {waiting && (
        <div className="sticky bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-[5] -mx-4 space-y-2 border-t border-line bg-wash/95 px-4 py-3 backdrop-blur">
          {!sendingOn && (
            <p className="text-sm text-warn">Sending from your mailbox is switched off, so this cannot be approved right now.</p>
          )}
          <ErrorNote error={approve.error ?? reject.error} />
          <div className="flex gap-2">
            <button
              type="button"
              className="hq-btn hq-btn-brand flex-[2]"
              disabled={busy || !sendingOn}
              onClick={() => approve.mutate(message.id, { onSuccess: () => successFeedback() })}
            >
              {approve.isPending ? 'Sending…' : 'Approve and send'}
            </button>
            <button type="button" className="hq-btn hq-btn-ghost flex-1" disabled={busy} onClick={() => reject.mutate(message.id)}>
              {reject.isPending ? '…' : 'Reject'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** What happened to a message that is no longer waiting or a preview. */
function Outcome({ message }: { message: OutboundMessage }) {
  const text =
    message.status === 'sent' || message.status === 'sending'
      ? message.status === 'sending'
        ? 'Sending…'
        : `Sent ${message.sentAt ? messageAge(message.sentAt) : ''}`.trim()
      : problemReason(message);
  const tone = message.status === 'sent' ? 'text-ok' : message.status === 'failed' ? 'text-warn' : 'text-slate';
  return (
    <Card>
      <p className={`text-sm ${tone}`}>{text}</p>
    </Card>
  );
}

/**
 * The files that go with it, opened one at a time in place. Fetched through
 * the API (the invoice PDF is rendered on request, the same renderer the send
 * uses), so what is shown is what is attached.
 */
function Attachments({ message }: { message: OutboundMessage }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="Attached">
      <ul className="space-y-3">
        {message.attachments.map((a) => {
          const key = `${a.kind}:${a.refId}`;
          const shown = open === key;
          return (
            <li key={key} className="space-y-2">
              <button
                type="button"
                className="hq-btn hq-btn-ghost w-full justify-between"
                aria-expanded={shown}
                onClick={() => setOpen(shown ? null : key)}
              >
                <span className="truncate">{a.filename}</span>
                <span className="num text-xs font-normal text-mute">{a.byteSize !== null ? fileSize(a.byteSize) : shown ? 'Hide' : 'View'}</span>
              </button>
              {shown && <DocumentPreview id={a.refId} path={attachmentPath(a)} contentType={a.contentType} filename={a.filename} />}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
