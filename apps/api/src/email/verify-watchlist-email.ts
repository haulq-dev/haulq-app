/**
 * The verification-changed email.
 *
 * HaulQ Verify's "automatic" half, restated: a broker's authority status
 * changed since the last time anyone checked, and someone should know. Same
 * plain, link-first shape `exception-alert-email.ts` already established —
 * this is the second email in the app built from a nightly sweep rather
 * than a request, and it should read like the first one, not like a new
 * voice.
 */

import type { Email } from './postmark.ts';

export interface VerifyWatchlistPayload {
  to: string;
  orgName: string;
  brokerName: string;
  previousStatus: string | null;
  newStatus: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const describe = (status: string | null) => (status ?? 'nothing on file').toLowerCase();

/** `webOrigin` is the app's origin — same reasoning as `exceptionAlertEmail`. */
export function verifyWatchlistEmail(payload: VerifyWatchlistPayload, webOrigin: string): Email {
  const link = `${webOrigin.replace(/\/$/, '')}/loads`;
  const from = describe(payload.previousStatus);
  const to = describe(payload.newStatus);

  const subject = `${payload.brokerName}'s FMCSA status changed — now ${to}`;

  const text = [
    `${payload.brokerName}'s FMCSA status changed for ${payload.orgName}: it was ${from},`,
    `and a nightly re-check now finds it ${to}.`,
    '',
    'Nothing about this load or any other was changed automatically — this is',
    'a heads up, not an action taken on your behalf.',
    '',
    'Open loads:',
    link,
    '',
    'HaulQ — run every load, know every dollar.',
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#123a63">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dfe8;padding:32px">',
    `<p style="margin:0 0 16px;font-size:18px;font-weight:600">${escapeHtml(payload.brokerName)}'s FMCSA status changed</p>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">It was <strong>${escapeHtml(from)}</strong>, and a nightly re-check now finds it <strong>${escapeHtml(to)}</strong>.</p>`,
    '<p style="margin:0 0 24px;font-size:15px;line-height:1.5">Nothing was changed automatically — this is a heads up, not an action taken on your behalf.</p>',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#ff6800;color:#fff;text-decoration:none;padding:12px 20px;font-weight:600;border-radius:2px">Open loads</a></p>`,
    '</div></body></html>',
  ].join('');

  return {
    to: payload.to,
    subject,
    text,
    html,
    tag: 'verify-watchlist',
  };
}
