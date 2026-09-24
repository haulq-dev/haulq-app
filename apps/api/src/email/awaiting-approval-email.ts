/**
 * "Autopilot has something for you to approve."
 *
 * The approval queue only works if someone knows it has something in it — a
 * drafted invoice nobody sees for a week is just a late invoice with extra
 * steps. Same plain, link-first shape as `exception-alert-email.ts`. It says
 * *how many* and nothing about *what*: no amounts, no broker names. The
 * detail is behind the link, where the person is signed in.
 */

import type { Email } from './postmark.ts';

export interface AwaitingApprovalPayload {
  to: string;
  orgName: string;
  /** Newly drafted this time. */
  count: number;
  /** Waiting in all, including earlier ones nobody has got to. */
  waiting: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function messages(n: number): string {
  return n === 1 ? '1 message' : `${n} messages`;
}

export function awaitingApprovalEmail(payload: AwaitingApprovalPayload, webOrigin: string): Email {
  const link = `${webOrigin.replace(/\/$/, '')}/autopilot`;
  const subject = `${messages(payload.waiting)} waiting for your OK`;

  // When earlier drafts are still sitting there, say so — it is the
  // difference between "new" and "you have a backlog".
  const more =
    payload.waiting > payload.count
      ? ` (${payload.count} new, ${payload.waiting - payload.count} from before)`
      : '';

  const text = [
    `HaulQ drafted ${messages(payload.count)} for ${payload.orgName} and is holding ${payload.count === 1 ? 'it' : 'them'} until you approve.`,
    `${messages(payload.waiting)} waiting in all${more}.`,
    '',
    'Nothing goes out until you say so. Read each one, then approve or reject it:',
    link,
    '',
    'HaulQ — run every load, know every dollar.',
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#123a63">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dfe8;padding:32px">',
    `<p style="margin:0 0 16px;font-size:18px;font-weight:600">${escapeHtml(messages(payload.waiting))} waiting for your OK</p>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">HaulQ drafted <strong>${escapeHtml(messages(payload.count))}</strong> for ${escapeHtml(payload.orgName)} and is holding ${payload.count === 1 ? 'it' : 'them'} until you approve${escapeHtml(more)}.</p>`,
    '<p style="margin:0 0 24px;font-size:15px;line-height:1.5">Nothing goes out until you say so. Read each one, then approve or reject it.</p>',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#ff6800;color:#fff;text-decoration:none;padding:12px 20px;font-weight:600;border-radius:2px">Review now</a></p>`,
    '</div></body></html>',
  ].join('');

  return { to: payload.to, subject, text, html, tag: 'awaiting-approval' };
}
