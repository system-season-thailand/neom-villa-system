// Builds the invoice PDF with jsPDF's vector drawing primitives (text/line/
// rect calls) for all Latin/numeric content — the vast majority of every
// invoice — which keeps the file small (jsPDF's built-in Helvetica is a
// "standard 14" PDF font: it's never embedded at all) and crisp at any zoom.
//
// Arabic text (e.g. an Arabic guest name) is the one exception: see the big
// comment above renderArabicToImage() in pdfCommon.js for why it's rendered
// via the browser's own text engine onto a canvas and embedded as a small
// image, rather than drawn as PDF vector text. That machinery — along with
// the document factory, colors, and page geometry — is shared with the
// Summary tab's statement (statementGenerator.js) and lives in pdfCommon.js.
import { formatDisplayDate } from './dateUtils.js';
import { formatIDR, formatNumber } from './format.js';
import { containsArabic } from './arabicReshaper.js';
import {
  PAGE_MARGIN,
  CONTENT_WIDTH,
  COLOR_INK,
  COLOR_MUTED,
  COLOR_ACCENT,
  COLOR_BORDER,
  COLOR_SURFACE,
  drawText,
  drawLabelValue,
  ensureArabicWebFontReady,
  tableHooks,
  newDoc,
  sanitizeForFileName,
  todayIsoLocal
} from './pdfCommon.js';

/**
 * @param {object} invoice
 * @param {string} invoice.invoiceNumber
 * @param {number} invoice.revisionNumber - the real, already-saved revision number returned by
 *   insert_invoice_revision() (1 for a brand-new invoice, 2 for its first revision, etc). The PDF
 *   itself displays this one lower (0, 1, ...) — see the displayRevision comment below — so the
 *   very first PDF anyone downloads for an invoice number reads "Revision 0", not "Revision 1".
 * @param {string} invoice.guestName
 * @param {string} [invoice.guestBy] - optional, who referred/booked the guest
 * @param {string} invoice.checkInDate - ISO date
 * @param {string} invoice.checkOutDate - ISO date
 * @param {number} invoice.nights
 * @param {string} invoice.villaType
 * @param {Array}  invoice.priceRows - [{startDate,endDate,nights,pricePerNight,seasonNote,subtotal}]
 * @param {number} invoice.total
 * @returns {Promise<{ blob: Blob, fileName: string }>}
 */
export async function generateInvoicePdf(invoice) {
  const hasArabic =
    containsArabic(invoice.guestName) || invoice.priceRows.some((row) => containsArabic(row.seasonNote));
  if (hasArabic) {
    await ensureArabicWebFontReady();
  }

  // Computed once, up front, and reused everywhere this invoice's number/
  // revision shows up (page header below, the footer's "Revision N" line,
  // and the downloaded file's name) — a single source of truth so those
  // three spots can never drift out of sync with each other.
  //
  // The database's revision_number is 1 for a brand-new invoice (so
  // MAX(revision_number)+1 numbering has no off-by-one elsewhere), but staff
  // read a first-time invoice as "Revision 0" and expect no "RevN" on it at
  // all — only an actual revision (the 2nd+ download of the same invoice
  // number) should say "Rev1" and up. Shifting the *displayed* number down
  // by one here keeps that DB invariant untouched.
  const displayRevision = invoice.revisionNumber - 1;
  const displayInvoiceNumber = buildDisplayInvoiceNumber(invoice);

  const doc = newDoc();
  doc.setProperties({
    title: `Invoice ${invoice.invoiceNumber}`,
    subject: `Neom Villa invoice for ${invoice.guestName}`,
    author: 'Neom Villa',
    creator: 'Neom Villa Staff Console'
  });

  let y = PAGE_MARGIN;

  // ---- Header: brand + invoice meta -------------------------------------
  drawText(doc, 'NEOM VILLA', PAGE_MARGIN, y + 4, { size: 18, weight: 'bold' });
  drawText(doc, 'Batu Layang, Kec. Cisarua,', PAGE_MARGIN, y + 10, { size: 8.5, color: COLOR_MUTED });
  drawText(doc, 'Kabupaten Bogor, Jawa Barat 16750', PAGE_MARGIN, y + 14.5, { size: 8.5, color: COLOR_MUTED });

  drawText(doc, 'INVOICE', PAGE_MARGIN + CONTENT_WIDTH, y + 4, {
    size: 18,
    weight: 'bold',
    color: COLOR_ACCENT,
    align: 'right'
  });
  // No "RevN" here at all for a first-ever download (displayRevision 0) —
  // only the footer's "Revision 0" line marks that case, matching how
  // Rev0 is also left off the downloaded file's name.
  drawText(
    doc,
    displayRevision > 0 ? `${displayInvoiceNumber} Rev${displayRevision}` : displayInvoiceNumber,
    PAGE_MARGIN + CONTENT_WIDTH,
    y + 11,
    { size: 11, weight: 'bold', align: 'right' }
  );
  drawText(doc, `Date: ${formatDisplayDate(invoice.generatedAt || todayIsoLocal())}`, PAGE_MARGIN + CONTENT_WIDTH, y + 16, {
    size: 8.5,
    color: COLOR_MUTED,
    align: 'right'
  });

  y += 24;
  doc.setDrawColor(...COLOR_BORDER);
  doc.setLineWidth(0.4);
  doc.line(PAGE_MARGIN, y, PAGE_MARGIN + CONTENT_WIDTH, y);

  // ---- Guest ---------------------------------------------------------
  y += 10;
  drawLabelValue(doc, 'Guest Name', invoice.guestName, PAGE_MARGIN, y);
  if (invoice.guestBy) {
    drawLabelValue(doc, 'Guest By', invoice.guestBy, PAGE_MARGIN + CONTENT_WIDTH, y, { align: 'right' });
  }

  // ---- Stay details panel --------------------------------------------
  y += 12;
  const panelH = 22;
  doc.setFillColor(...COLOR_SURFACE);
  doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, panelH, 2, 2, 'F');

  const colW = CONTENT_WIDTH / 4;
  const cy = y + 8;
  drawLabelValue(doc, 'Check-in', formatDisplayDate(invoice.checkInDate), PAGE_MARGIN + 8, cy);
  drawLabelValue(doc, 'Check-out', formatDisplayDate(invoice.checkOutDate), PAGE_MARGIN + colW + 4, cy);
  drawLabelValue(doc, 'Nights', String(invoice.nights), PAGE_MARGIN + colW * 2 + 4, cy);
  drawLabelValue(doc, 'Villa Type', invoice.villaType, PAGE_MARGIN + colW * 3 + 4, cy);

  y += panelH + 14;

  // ---- Charges table ---------------------------------------------------
  drawText(doc, 'VILLA CHARGES', PAGE_MARGIN, y, { size: 9, weight: 'bold', color: COLOR_MUTED });
  y += 4;

  const body = invoice.priceRows.map((row) => [
    row.nights === 1
      ? formatDisplayDate(row.startDate)
      : `${formatDisplayDate(row.startDate)} - ${formatDisplayDate(row.endDate)}`,
    row.seasonNote || '-',
    String(row.nights),
    formatNumber(row.pricePerNight),
    formatNumber(row.subtotal)
  ]);

  doc.autoTable({
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Period', 'Season', 'Nights', 'Rate / Night (IDR)', 'Amount (IDR)']],
    body,
    theme: 'plain',
    styles: {
      font: 'helvetica',
      fontSize: 9.5,
      textColor: COLOR_INK,
      cellPadding: { top: 3.2, bottom: 3.2, left: 2, right: 2 },
      lineColor: COLOR_BORDER,
      lineWidth: 0.2
    },
    headStyles: {
      fontStyle: 'bold',
      fontSize: 8,
      textColor: COLOR_MUTED,
      fillColor: false,
      lineWidth: { bottom: 0.6 },
      lineColor: COLOR_INK
    },
    bodyStyles: { lineWidth: { bottom: 0.2 } },
    // Widths and weights only — halign is set for every section by
    // tableHooks() below, since autoTable would apply it to body cells alone
    // from here and leave the headers out of line. See pdfCommon.js.
    columnStyles: {
      2: { cellWidth: 18 },
      3: { cellWidth: 34 },
      4: { cellWidth: 34, fontStyle: 'bold' }
    },
    // Column alignment across head/body/foot, plus Arabic season notes via
    // the shared canvas-rendering path — see tableHooks() in pdfCommon.js.
    ...tableHooks({ columnCount: 5, sizePt: 9.5 })
  });

  y = doc.lastAutoTable.finalY + 8;

  // ---- Total -------------------------------------------------------------
  doc.setDrawColor(...COLOR_INK);
  doc.setLineWidth(0.6);
  doc.line(PAGE_MARGIN + CONTENT_WIDTH - 74, y, PAGE_MARGIN + CONTENT_WIDTH, y);
  y += 8;
  drawText(doc, 'TOTAL', PAGE_MARGIN + CONTENT_WIDTH - 74, y, { size: 11, weight: 'bold', color: COLOR_MUTED });
  drawText(doc, formatIDR(invoice.total), PAGE_MARGIN + CONTENT_WIDTH, y, {
    size: 15,
    weight: 'bold',
    align: 'right'
  });

  // ---- Footer --------------------------------------------------------
  const footerY = 297 - PAGE_MARGIN;
  doc.setDrawColor(...COLOR_BORDER);
  doc.setLineWidth(0.3);
  doc.line(PAGE_MARGIN, footerY - 10, PAGE_MARGIN + CONTENT_WIDTH, footerY - 10);
  drawText(doc, `Revision ${displayRevision}`, PAGE_MARGIN, footerY - 4, { size: 8, color: COLOR_MUTED });
  drawText(doc, 'Thank you for staying with Neom Villa.', PAGE_MARGIN + CONTENT_WIDTH, footerY - 4, {
    size: 8,
    color: COLOR_MUTED,
    align: 'right'
  });

  const blob = doc.output('blob');
  const fileName = buildFileName(invoice.guestName, displayInvoiceNumber, displayRevision);
  return { blob, fileName };
}

const ROMAN_MONTHS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/**
 * "INV-N-VII-26-0124" — shown on the PDF page itself (next to "INVOICE", top
 * right) and reused as-is inside both the downloaded file's name and (with
 * " RevN" appended — see generateInvoicePdf) nowhere else, so all three
 * never drift apart. "INV-N-" is a fixed prefix; the roman-numeral month and
 * 2-digit year are *today's* — the moment this PDF is actually being
 * generated/downloaded — not any date stored on the invoice itself, so
 * re-downloading the same saved invoice next month produces a different
 * number here (by design, matching the villa's own convention, not a bug).
 * The 4-digit sequence is invoiceNumber's own trailing segment, e.g. "0124"
 * out of "INV-2026-0124".
 */
function buildDisplayInvoiceNumber(invoice) {
  const now = new Date();
  const monthRoman = ROMAN_MONTHS[now.getMonth()];
  const yy = String(now.getFullYear()).slice(-2);
  const seq = invoice.invoiceNumber.split('-').pop();
  return `INV-N-${monthRoman}-${yy}-${seq}`;
}

/** "ALZOBIDI MOSLEH FAYEZ INV-N-VII-26-0124" (plus " Rev1", "Rev2", … for an
 * actual revision — never "Rev0", since displayRevision 0 means this is the
 * first-ever download of this invoice number) — see buildDisplayInvoiceNumber
 * above for where displayInvoiceNumber itself comes from. */
function buildFileName(guestName, displayInvoiceNumber, displayRevision) {
  const guestNameUpper = sanitizeForFileName(guestName).toUpperCase();
  const revSuffix = displayRevision > 0 ? ` Rev${displayRevision}` : '';
  return `${guestNameUpper} ${displayInvoiceNumber}${revSuffix}.pdf`;
}
