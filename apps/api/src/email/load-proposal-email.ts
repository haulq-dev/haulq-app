/**
 * "A rate confirmation is ready to become a load."
 *
 * The proposal is only useful if someone looks at it, and the point of it is that
 * nobody has to go looking: a broker's rate confirmation lands, HaulQ reads it as
 * a load, and whoever dispatches is told. Same plain, link-first shape as
 * `awaiting-approval-email.ts`. It says which document and how many stops, and
 * nothing about the broker or the rate: the detail is behind the link, where the
 * person is signed in.
 */

import type { Email } from './postmark.ts';

export interface LoadProposalReadyPayload {
  to: string;
  orgName: string;
  filename: string;
  proposalId: string;
  stops: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function loadProposalReadyEmail(payload: LoadProposalReadyPayload, webOrigin: string): Email {
  const link = `${webOrigin.replace(/\/$/, '')}/proposals/${encodeURIComponent(payload.proposalId)}`;
  const subject = 'A rate confirmation is ready to become a load';
  const stops = `${payload.stops} stop${payload.stops === 1 ? '' : 's'}`;

  const text = [
    `HaulQ read ${payload.filename} for ${payload.orgName} and drafted a load from it (${stops}).`,
    '',
    'Nothing has been created. Look it over, fix anything that is wrong, and create the load,',
    'or dismiss it if it is not one:',
    link,
    '',
    'HaulQ — run every load, know every dollar.',
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#123a63">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dfe8;padding:32px">',
    '<p style="margin:0 0 16px;font-size:18px;font-weight:600">A rate confirmation is ready to become a load</p>',
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">HaulQ read <strong>${escapeHtml(payload.filename)}</strong> for ${escapeHtml(payload.orgName)} and drafted a load from it (${escapeHtml(stops)}).</p>`,
    '<p style="margin:0 0 24px;font-size:15px;line-height:1.5">Nothing has been created. Look it over, fix anything that is wrong, and create the load, or dismiss it if it is not one.</p>',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#ff6800;color:#fff;text-decoration:none;padding:12px 20px;font-weight:600;border-radius:2px">Review the load</a></p>`,
    '</div></body></html>',
  ].join('');

  return { to: payload.to, subject, text, html, tag: 'load-proposal-ready' };
}
