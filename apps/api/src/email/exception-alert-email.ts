/**
 * The exception-alert email.
 *
 * Track's own promise, restated: automatic status updates, escalating to a
 * human on exceptions. This is what "escalating" looks like — same plain,
 * link-first shape `invite-email.ts` already established, for the same
 * reason: the first mail about a quiet load should not need a spam filter
 * to trust it.
 */

import type { Email } from './postmark.ts';

export interface ExceptionAlertPayload {
  to: string;
  orgName: string;
  loadReference: number;
  hoursSinceActivity: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `webOrigin` is the app's origin — same reasoning as `inviteEmail`. */
export function exceptionAlertEmail(payload: ExceptionAlertPayload, webOrigin: string): Email {
  const link = `${webOrigin.replace(/\/$/, '')}/loads`;
  const hours = payload.hoursSinceActivity;

  const subject = `Load ${payload.loadReference} has gone quiet — ${hours}h with no update`;

  const text = [
    `Load ${payload.loadReference} for ${payload.orgName} has reported nothing — no check-in,`,
    `no position — in over ${hours} hours while marked in transit.`,
    '',
    'A phone call to the driver is the fastest way to find out what is actually',
    'happening. Once something is reported, this clears on its own.',
    '',
    'Open the load:',
    link,
    '',
    'HaulQ — run every load, know every dollar.',
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#123a63">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dfe8;padding:32px">',
    `<p style="margin:0 0 16px;font-size:18px;font-weight:600">Load ${payload.loadReference} has gone quiet</p>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">No check-in and no position update in over <strong>${hours} hours</strong> while marked in transit.</p>`,
    '<p style="margin:0 0 24px;font-size:15px;line-height:1.5">A phone call to the driver is the fastest way to find out what is actually happening. Once something is reported, this clears on its own.</p>',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#ff6800;color:#fff;text-decoration:none;padding:12px 20px;font-weight:600;border-radius:2px">Open the load</a></p>`,
    '</div></body></html>',
  ].join('');

  return {
    to: payload.to,
    subject,
    text,
    html,
    tag: 'exception-alert',
  };
}
