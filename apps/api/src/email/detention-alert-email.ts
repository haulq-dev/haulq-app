/**
 * The detention-alert email.
 *
 * Same plain, link-first shape `exception-alert-email.ts` already
 * established for a Track sweep escalating to a human — the difference is
 * timing: this fires once, the moment a stop crosses free time, rather than
 * after hours of silence.
 */

import type { Email } from './postmark.ts';

export interface DetentionAlertPayload {
  to: string;
  orgName: string;
  loadReference: number;
  stopSeq: number;
  city: string;
  state: string;
  detentionMinutes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} minutes`;
  return `${hours}h ${mins}m`;
};

/** `webOrigin` is the app's origin — same reasoning as `exceptionAlertEmail`. */
export function detentionAlertEmail(payload: DetentionAlertPayload, webOrigin: string): Email {
  const link = `${webOrigin.replace(/\/$/, '')}/loads`;
  const place = `${payload.city}, ${payload.state}`;
  const over = formatMinutes(payload.detentionMinutes);

  const subject = `Load ${payload.loadReference} is now in detention at stop ${payload.stopSeq}`;

  const text = [
    `Load ${payload.loadReference} for ${payload.orgName} has been on site at stop`,
    `${payload.stopSeq} (${place}) longer than the broker's free time — ${over} over, as of now.`,
    '',
    'This is the moment to start the clock with the broker, not after the fact —',
    'detention evidence is strongest logged as it happens.',
    '',
    'Open the load:',
    link,
    '',
    'HaulQ — run every load, know every dollar.',
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#123a63">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dfe8;padding:32px">',
    `<p style="margin:0 0 16px;font-size:18px;font-weight:600">Load ${payload.loadReference} is now in detention</p>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">Stop ${payload.stopSeq} (${escapeHtml(place)}) has run <strong>${escapeHtml(over)}</strong> past the broker's free time.</p>`,
    '<p style="margin:0 0 24px;font-size:15px;line-height:1.5">This is the moment to start the clock with the broker — detention evidence is strongest logged as it happens.</p>',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#ff6800;color:#fff;text-decoration:none;padding:12px 20px;font-weight:600;border-radius:2px">Open the load</a></p>`,
    '</div></body></html>',
  ].join('');

  return {
    to: payload.to,
    subject,
    text,
    html,
    tag: 'detention-alert',
  };
}
