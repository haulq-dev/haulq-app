/**
 * An invoice as a PDF. `FEATURE_REQUESTS_PLAN.md` section 8.
 *
 * Nothing in HaulQ produced an invoice *document* before this — `invoices`
 * is a record, and "sending" one was a status change. A broker or factor
 * pays against a document, so this renders one from the invoice's own
 * snapshot (see `getInvoiceRenderFacts`): what was billed, not what the
 * load would bill today.
 *
 * Deliberately plain: one page, standard fonts, the facts a payer needs to
 * match it against their own records — who is billing, invoice number and
 * date, their load number, the lane, line items, the total, the terms. It
 * carries **no remittance details**, because HaulQ does not hold any (bank
 * or lockbox information, or a factor's remit-to). A payer has those from
 * the carrier's setup packet; if a carrier wants them on the page, that is
 * a field to add here, not a thing to guess.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { formatMoney, type InvoiceRenderFacts } from '@haulq/db';

const PAGE = { width: 612, height: 792 };
const MARGIN = 54;

/**
 * pdf-lib's standard fonts can only draw WinAnsi characters and *throw* on
 * anything else — a broker named with an emoji, or an arrow in a lane,
 * would fail the whole send. Anything outside the printable Latin-1 range
 * becomes `?`, which is ugly and survivable; a thrown error is neither.
 */
export function winAnsi(text: string): string {
  return [...text.replace(/[\r\n\t]+/g, ' ')]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? ch : '?';
    })
    .join('');
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = winAnsi(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const day = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export async function renderInvoicePdf(facts: InvoiceRenderFacts): Promise<Buffer> {
  const doc = await PDFDocument.create();
  // Fixed dates so the same invoice renders to the same bytes — the
  // checksum recorded on a sent message is then a fact about the invoice,
  // not about the second it was rendered.
  doc.setCreationDate(facts.createdAt);
  doc.setModificationDate(facts.createdAt);
  doc.setProducer('HaulQ');
  doc.setTitle(winAnsi(`Invoice ${facts.reference}`));

  const page = doc.addPage([PAGE.width, PAGE.height]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const mute = rgb(0.4, 0.4, 0.45);
  const rule = rgb(0.8, 0.8, 0.83);

  const right = PAGE.width - MARGIN;
  const textRight = (t: string, y: number, font: PDFFont, size: number, color = ink) => {
    const s = winAnsi(t);
    page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y, size, font, color });
  };
  const text = (t: string, x: number, y: number, font: PDFFont, size: number, color = ink) =>
    page.drawText(winAnsi(t), { x, y, size, font, color });

  let y = PAGE.height - MARGIN;

  // Header: who is billing, on the left; the invoice's identity on the right.
  text(facts.carrierName, MARGIN, y - 14, bold, 16);
  if (facts.mcNumber) text(`MC ${facts.mcNumber}`, MARGIN, y - 30, regular, 10, mute);
  textRight('INVOICE', y - 14, bold, 20);
  textRight(`No. ${facts.reference}`, y - 32, regular, 11);
  textRight(`Date: ${day(facts.createdAt)}`, y - 46, regular, 10, mute);
  if (facts.dueAt) textRight(`Due: ${day(facts.dueAt)}`, y - 60, regular, 10, mute);
  else if (facts.paymentTermsDays != null) textRight(`Terms: net ${facts.paymentTermsDays} days`, y - 60, regular, 10, mute);
  y -= 84;

  page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.5, color: rule });
  y -= 22;

  // Bill to, and the load it is for.
  text('BILL TO', MARGIN, y, bold, 8, mute);
  text('LOAD', 330, y, bold, 8, mute);
  y -= 15;
  const billTo = [facts.brokerName ?? '', facts.brokerEmail ?? ''].filter(Boolean);
  const loadLines = [
    facts.brokerLoadNumber ? `Your load ${facts.brokerLoadNumber}` : `Load ${facts.loadReference}`,
    facts.origin && facts.destination ? `${facts.origin} to ${facts.destination}` : '',
    facts.deliveredAt ? `Delivered ${day(facts.deliveredAt)}` : '',
  ].filter(Boolean);
  const rows = Math.max(billTo.length, loadLines.length);
  for (let i = 0; i < rows; i++) {
    if (billTo[i]) text(billTo[i]!, MARGIN, y - i * 14, i === 0 ? bold : regular, 10.5);
    if (loadLines[i]) text(loadLines[i]!, 330, y - i * 14, regular, 10.5);
  }
  y -= rows * 14 + 24;

  // Line items.
  page.drawLine({ start: { x: MARGIN, y: y + 6 }, end: { x: right, y: y + 6 }, thickness: 0.5, color: rule });
  text('DESCRIPTION', MARGIN, y - 8, bold, 8, mute);
  textRight('AMOUNT', y - 8, bold, 8, mute);
  y -= 26;
  const descWidth = right - MARGIN - 110;
  for (const item of facts.lineItems) {
    const lines = wrap(item.description, regular, 10.5, descWidth);
    lines.forEach((l, i) => text(l, MARGIN, y - i * 13, regular, 10.5));
    textRight(formatMoney(item.amountCents, item.currency), y, regular, 10.5);
    y -= lines.length * 13 + 8;
  }

  page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: right, y: y + 2 }, thickness: 0.5, color: rule });
  y -= 22;
  textRight(`Total due   ${formatMoney(facts.totalCents, facts.currency)}`, y, bold, 13);

  return Buffer.from(await doc.save());
}
