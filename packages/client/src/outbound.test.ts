import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canConfigureOutbound, canReviewOutbound } from './access.ts';
import {
  ACTION_POSITIONS,
  actionTitle,
  attachmentPath,
  defaultTab,
  firstRunSteps,
  groupMessages,
  messageAge,
  modeForPosition,
  positionAllowed,
  positionFor,
  previewReason,
  problemReason,
  relatedLabel,
  tabFor,
  type OutboundMessage,
} from './outbound.ts';

const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: '00000000-0000-4000-8000-000000000001',
  actionType: 'payment_reminder',
  mode: 'draft',
  status: 'pending_approval',
  holdReason: null,
  toAddresses: ['ap@broker.example.com'],
  subject: 'Overdue',
  body: 'Body',
  attachments: [],
  relatedType: null,
  relatedId: null,
  error: null,
  sentAt: null,
  createdAt: new Date().toISOString(),
  ...over,
});

describe('outbound roles', () => {
  it('lets owner, dispatcher and accountant review, and only the owner configure', () => {
    for (const role of ['owner', 'dispatcher', 'accountant']) assert.equal(canReviewOutbound(role), true);
    for (const role of ['driver', undefined]) assert.equal(canReviewOutbound(role), false);
    assert.equal(canConfigureOutbound('owner'), true);
    for (const role of ['dispatcher', 'accountant', 'driver']) assert.equal(canConfigureOutbound(role), false);
  });
});

describe('the per-action control', () => {
  it('never uses the server’s words for what the carrier sees', () => {
    const words = ACTION_POSITIONS.map((p) => `${p.label} ${p.help}`).join(' ');
    assert.doesNotMatch(words, /shadow|draft|\bact\b/i);
  });

  it('maps positions to modes, with off meaning no setting at all', () => {
    assert.equal(modeForPosition('off'), null);
    assert.equal(modeForPosition('preview'), 'shadow');
    assert.equal(modeForPosition('ask'), 'draft');
    assert.equal(modeForPosition('auto'), 'act');
  });

  it('reads absent as off, not as a preview', () => {
    assert.equal(positionFor({ configured: {} }, 'payment_reminder'), 'off');
    assert.equal(positionFor({ configured: { payment_reminder: 'shadow' } }, 'payment_reminder'), 'preview');
    assert.equal(positionFor({ configured: { payment_reminder: 'act' } }, 'payment_reminder'), 'auto');
  });

  it('disables positions above the ceiling, with a reason', () => {
    const invoice = { maxMode: 'draft' as const };
    assert.deepEqual(positionAllowed(invoice, 'ask'), { allowed: true });
    const auto = positionAllowed(invoice, 'auto');
    assert.equal(auto.allowed, false);
    assert.match((auto as { reason: string }).reason, /needs your OK/);
    assert.deepEqual(positionAllowed({ maxMode: 'act' }, 'auto'), { allowed: true });
    assert.deepEqual(positionAllowed(invoice, 'off'), { allowed: true });
  });

  it('titles the actions a carrier can set, and falls back to the registry label', () => {
    assert.equal(actionTitle('invoice_delivery'), 'Invoice emails');
    assert.equal(actionTitle('detention_claim'), 'Detention claim');
    assert.equal(actionTitle('something_new'), 'something_new');
  });
});

describe('sorting messages into tabs', () => {
  it('puts every status on exactly one tab', () => {
    assert.equal(tabFor({ status: 'pending_approval' }), 'approve');
    assert.equal(tabFor({ status: 'shadow' }), 'preview');
    assert.equal(tabFor({ status: 'sending' }), 'sent');
    assert.equal(tabFor({ status: 'sent' }), 'sent');
    for (const status of ['failed', 'rejected', 'expired'] as const) assert.equal(tabFor({ status }), 'problems');
  });

  it('groups a list', () => {
    const groups = groupMessages([msg(), msg({ status: 'shadow' }), msg({ status: 'expired' }), msg({ status: 'failed' })]);
    assert.deepEqual(
      [groups.approve.length, groups.preview.length, groups.sent.length, groups.problems.length],
      [1, 1, 0, 2],
    );
  });

  it('says why a preview was held, and what went wrong on a problem', () => {
    assert.match(previewReason({ holdReason: 'sending_disabled' }), /switched off/);
    assert.match(previewReason({ holdReason: 'not_connected' }), /no mailbox/);
    assert.match(previewReason({ holdReason: null }), /preview/);
    assert.equal(problemReason({ status: 'failed', error: 'A file was missing.' }), 'A file was missing.');
    assert.match(problemReason({ status: 'expired', error: null }), /out of date/);
    assert.match(problemReason({ status: 'rejected', error: null }), /rejected/);
    for (const status of ['failed', 'rejected', 'expired'] as const) {
      assert.doesNotMatch(problemReason({ status, error: null }), /shadow|draft/i, 'the server’s words stay out of the copy');
    }
  });

  it('says how old something is', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    assert.equal(messageAge(ago(10_000), now), 'just now');
    assert.equal(messageAge(ago(5 * 60_000), now), '5 min ago');
    assert.equal(messageAge(ago(3 * 3_600_000), now), '3 h ago');
    assert.equal(messageAge(ago(86_400_000), now), '1 day ago');
    assert.equal(messageAge(ago(3 * 86_400_000), now), '3 days ago');
  });

  it('points attachments at the real bytes, and labels what a message is about', () => {
    assert.equal(attachmentPath({ kind: 'invoice', refId: 'abc' }), '/v1/invoices/abc/pdf');
    assert.equal(attachmentPath({ kind: 'document', refId: 'abc' }), '/v1/documents/abc/content');
    assert.equal(relatedLabel({ relatedType: 'load' }), 'About a load');
    assert.equal(relatedLabel({ relatedType: 'broker' }), 'About a broker');
    assert.equal(relatedLabel({ relatedType: null }), null);
  });
});

describe('first run', () => {
  const actions = [
    { type: 'invoice_delivery' as const, label: 'x', maxMode: 'draft' as const, available: true },
    { type: 'payment_reminder' as const, label: 'x', maxMode: 'act' as const, available: true },
    { type: 'detention_claim' as const, label: 'x', maxMode: 'draft' as const, available: false },
  ];

  it('counts an action as chosen only when every available one is set — an unavailable one does not matter', () => {
    const none = firstRunSteps({ mailbox: { connected: false }, settings: { configured: {}, actions }, messages: [] });
    assert.deepEqual(none.map((s) => s.done), [false, false, false]);

    const half = firstRunSteps({ mailbox: { connected: true }, settings: { configured: { invoice_delivery: 'shadow' }, actions }, messages: [] });
    assert.deepEqual(half.map((s) => s.done), [true, false, false]);

    const done = firstRunSteps({
      mailbox: { connected: true },
      settings: { configured: { invoice_delivery: 'shadow', payment_reminder: 'shadow' }, actions },
      messages: [msg()],
    });
    assert.deepEqual(done.map((s) => s.done), [true, true, true]);
  });

  it('opens on what is waiting, else on settings for a new or returning owner, else on approvals', () => {
    const configured = { configured: { payment_reminder: 'shadow' as const } };
    assert.equal(defaultTab({ pending: 2, settings: { configured: {} }, returningFromMailbox: false, canConfigure: true }), 'approve');
    assert.equal(defaultTab({ pending: 0, settings: { configured: {} }, returningFromMailbox: false, canConfigure: true }), 'settings');
    assert.equal(defaultTab({ pending: 0, settings: configured, returningFromMailbox: true, canConfigure: true }), 'settings');
    assert.equal(defaultTab({ pending: 0, settings: configured, returningFromMailbox: false, canConfigure: true }), 'approve');
    // A dispatcher or accountant has no Settings tab to land on.
    assert.equal(defaultTab({ pending: 0, settings: { configured: {} }, returningFromMailbox: false, canConfigure: false }), 'approve');
  });
});
