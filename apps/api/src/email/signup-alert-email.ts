/**
 * Tells the HaulQ team a new carrier signed up. Sent to `SIGNUP_ALERT_EMAIL`,
 * not to the carrier, so someone knows to review it for the pilot
 * (`REQUIRE_PILOT_APPROVAL`, `scripts/approve-pilot.ts`).
 */

import type { Email } from './postmark.ts';

export interface SignupAlertPayload {
  to: string;
  orgId: string;
  orgName: string;
  contactEmail: string;
  ownerEmail: string | null;
  /** Whether this carrier still needs approving before it can subscribe. */
  needsApproval: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function signupAlertEmail(payload: SignupAlertPayload): Email {
  const subject = `New HaulQ sign-up: ${payload.orgName}`;
  const approve = `node --experimental-strip-types apps/api/src/scripts/approve-pilot.ts --org ${payload.orgId.slice(0, 8)} --apply`;

  const facts: Array<[string, string]> = [
    ['Carrier', payload.orgName],
    ['Contact email', payload.contactEmail],
    ...(payload.ownerEmail && payload.ownerEmail !== payload.contactEmail
      ? ([['Signed up as', payload.ownerEmail]] as Array<[string, string]>)
      : []),
    ['Carrier id', payload.orgId],
  ];

  const next = payload.needsApproval
    ? ['They are waiting on pilot approval and cannot subscribe yet. To approve, run this in Render → haulq-api → Shell:', approve]
    : ['Pilot approval is off, so they can subscribe right away.'];

  const text = [
    `${payload.orgName} just created a HaulQ account.`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    ...next,
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#123a63">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dfe8;padding:32px">',
    `<p style="margin:0 0 16px;font-size:18px;font-weight:600">New sign-up: ${escapeHtml(payload.orgName)}</p>`,
    '<table style="margin:0 0 20px;font-size:15px;line-height:1.6;border-collapse:collapse">',
    ...facts.map(
      ([k, v]) => `<tr><td style="padding:0 16px 0 0;color:#5b6b7f">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`,
    ),
    '</table>',
    payload.needsApproval
      ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">They are waiting on pilot approval and cannot subscribe yet. To approve, run this in Render → haulq-api → Shell:</p><pre style="margin:0;padding:12px;background:#f1f4f8;font-size:13px;white-space:pre-wrap;word-break:break-all">${escapeHtml(approve)}</pre>`
      : '<p style="margin:0;font-size:15px;line-height:1.5">Pilot approval is off, so they can subscribe right away.</p>',
    '</div></body></html>',
  ].join('');

  return { to: payload.to, subject, text, html, tag: 'signup-alert' };
}
