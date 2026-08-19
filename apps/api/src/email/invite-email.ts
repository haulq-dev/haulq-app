/**
 * The invitation email.
 *
 * Written as one function returning both bodies, so the text and HTML versions
 * cannot drift. A plain-text part is not optional: spam filters score messages
 * without one, and this is the first mail a carrier ever receives from HaulQ.
 *
 * Deliberately plain. No images, no tracking pixel, no button graphic — the
 * link is the payload and anything wrapping it is another thing that can render
 * badly in Outlook or trip a filter.
 */

import type { Email } from './postmark.ts';

export interface InvitePayload {
  email: string;
  role: string;
  token: string;
  orgName: string;
  /** ISO. Shown so the recipient knows the link is not indefinite. */
  expiresAt?: string;
  invitedByEmail?: string | null;
}

const ROLE_SENTENCE: Record<string, string> = {
  owner: 'full access, including billing and members',
  dispatcher: 'booking loads and managing trucks and drivers',
  driver: 'their own loads and documents',
  accountant: 'invoices, settlements and reports',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function daysUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return Number.isFinite(days) ? days : null;
}

/**
 * `webOrigin` is the app's origin, not the API's — the link goes to a screen a
 * person opens, not an endpoint. Passed in rather than read from the
 * environment here so the same function can be exercised in a test.
 */
export function inviteEmail(payload: InvitePayload, webOrigin: string): Email {
  // encodeURIComponent, even though the token is base64url and has nothing to
  // escape today. If the encoding ever changes, a raw `+` in a path is a broken
  // link that only shows up in production.
  const link = `${webOrigin.replace(/\/$/, '')}/invite/${encodeURIComponent(payload.token)}`;

  const what = ROLE_SENTENCE[payload.role] ?? payload.role;
  const from = payload.invitedByEmail ? ` by ${payload.invitedByEmail}` : '';
  const days = daysUntil(payload.expiresAt);
  const expiry = days !== null && days > 0
    ? `This link expires in ${days} day${days === 1 ? '' : 's'}.`
    : 'This link expires shortly.';

  const subject = `${payload.orgName} invited you to HaulQ`;

  const text = [
    `You have been invited${from} to join ${payload.orgName} on HaulQ as a ${payload.role}.`,
    '',
    `That gives you ${what}.`,
    '',
    'Open this link to accept:',
    link,
    '',
    expiry,
    '',
    'If you were not expecting this, ignore it — nothing happens until the link is opened.',
    '',
    'HaulQ — run every load, know every dollar.',
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#123a63">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dfe8;padding:32px">',
    `<p style="margin:0 0 16px;font-size:18px;font-weight:600">${escapeHtml(payload.orgName)} invited you to HaulQ</p>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">You have been invited${escapeHtml(from)} to join as a <strong>${escapeHtml(payload.role)}</strong> — ${escapeHtml(what)}.</p>`,
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#ff6800;color:#fff;text-decoration:none;padding:12px 20px;font-weight:600;border-radius:2px">Accept the invitation</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#334155">Or paste this into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>`,
    `<p style="margin:0 0 8px;font-size:13px;color:#94a3b8">${escapeHtml(expiry)}</p>`,
    '<p style="margin:0;font-size:13px;color:#94a3b8">If you were not expecting this, ignore it — nothing happens until the link is opened.</p>',
    '</div></body></html>',
  ].join('');

  return {
    to: payload.email,
    subject,
    text,
    html,
    tag: 'invite',
  };
}
