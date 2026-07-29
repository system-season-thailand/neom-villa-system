// Builds the invoice PDF with jsPDF's vector drawing primitives (text/line/
// rect calls) for all Latin/numeric content — the vast majority of every
// invoice — which keeps the file small (jsPDF's built-in Helvetica is a
// "standard 14" PDF font: it's never embedded at all) and crisp at any zoom.
//
// Arabic text (e.g. the "عميل خاص" guest name) is the one exception: see the
// big comment above renderArabicToImage() for why it's rendered via the
// browser's own text engine onto a canvas and embedded as a small image,
// rather than drawn as PDF vector text.
import { formatDisplayDate } from './dateUtils.js';
import { formatIDR, formatNumber } from './format.js';
import { containsArabic } from './arabicReshaper.js';

const PAGE_MARGIN = 18;
const PAGE_WIDTH = 210;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const COLOR_INK = [26, 28, 32];
const COLOR_MUTED = [110, 114, 122];
const COLOR_ACCENT = [181, 98, 47];
const COLOR_BORDER = [225, 227, 231];
const COLOR_SURFACE = [247, 247, 248];

const MM_PER_PT = 25.4 / 72;
// Render at a high internal resolution so the embedded image stays crisp
// even when the PDF is zoomed in or printed (roughly 300+ effective DPI for
// normal invoice text sizes).
const ARABIC_CANVAS_SCALE = 6;
const ARABIC_FONT_FAMILY = 'Tajawal'; // already loaded by index.html for the app's own Arabic UI text

/**
 * Arabic text is the one thing on this invoice jsPDF cannot be trusted to
 * draw correctly. jsPDF has no text-shaping engine, so the standard
 * workaround (used throughout most jsPDF+Arabic tutorials) is to pre-shape
 * the text into Unicode presentation-form glyphs yourself and hand jsPDF an
 * already-reordered string. That was this app's original approach — but
 * testing (across two different well-regarded Arabic fonts and two major
 * jsPDF versions) turned up a real, reproducible bug: specific letter pairs
 * (e.g. ي→ل, ك→ل, م→ل) render with a visible gap instead of the connected
 * cursive stroke Arabic requires, because jsPDF/the font's presentation-form
 * glyphs don't position correctly relative to each other in that code path.
 * It isn't a shaping-table bug on this app's side — the same broken spacing
 * reproduces with the *original, unsubsetted* font files.
 *
 * The reliable fix is to stop asking jsPDF to lay the glyphs out at all.
 * Every browser's <canvas> 2D text API goes through the same real text-
 * shaping stack as normal DOM text (HarfBuzz/DirectWrite/CoreText
 * depending on OS), so it renders Arabic correctly by construction. This
 * function draws the given Arabic string to an offscreen canvas at high
 * resolution and returns a PNG data URL plus its size in PDF millimeters,
 * for embedding with doc.addImage(). Everything else on the invoice is
 * still pure vector text — only the Arabic run itself becomes a (small,
 * high-DPI) image. See PDF_ENGINE.md for the trade-off this implies for
 * copy/paste and text search.
 */
function renderArabicToImage(text, { sizePt, weight = '400', color = COLOR_INK } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const pxSize = sizePt * ARABIC_CANVAS_SCALE;
  const pad = Math.ceil(pxSize * 0.08);

  ctx.font = `${weight} ${pxSize}px ${ARABIC_FONT_FAMILY}`;
  const measured = ctx.measureText(text);
  const ascent = Math.ceil(measured.actualBoundingBoxAscent || pxSize * 0.82);
  const descent = Math.ceil(measured.actualBoundingBoxDescent || pxSize * 0.24);
  const width = Math.ceil(measured.width) + pad * 2;
  const height = ascent + descent + pad * 2;

  canvas.width = width;
  canvas.height = height;
  // Resizing a canvas clears all context state, so font/fill must be reapplied.
  ctx.font = `${weight} ${pxSize}px ${ARABIC_FONT_FAMILY}`;
  ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, width - pad, ascent + pad);

  return {
    dataUrl: canvas.toDataURL('image/png'),
    widthMM: (width / ARABIC_CANVAS_SCALE) * MM_PER_PT,
    heightMM: (height / ARABIC_CANVAS_SCALE) * MM_PER_PT,
    // Fraction of the image's height that sits above the text baseline —
    // needed to convert jsPDF's baseline-relative y into the image's top-left y.
    baselineRatio: (ascent + pad) / height
  };
}

/** Ensures the Arabic web font used by renderArabicToImage() is actually
 * loaded before anything tries to measure/draw it — otherwise the very
 * first Arabic invoice of a session could silently fall back to a generic
 * serif and measure/draw incorrectly. */
async function ensureArabicWebFontReady() {
  if (document.fonts?.ready) {
    try {
      await Promise.all([
        document.fonts.load(`400 32px ${ARABIC_FONT_FAMILY}`),
        document.fonts.load(`700 32px ${ARABIC_FONT_FAMILY}`)
      ]);
      await document.fonts.ready;
    } catch {
      // If font loading APIs are unavailable or the load fails, proceed anyway —
      // the browser will fall back to its default font rather than throwing.
    }
  }
}

/** Draws `text` as vector PDF text, or — for Arabic — as an embedded image (see renderArabicToImage above). */
function drawText(doc, text, x, y, { size = 10, weight = 'normal', color = COLOR_INK, align = 'left' } = {}) {
  const value = text == null ? '' : String(text);

  if (containsArabic(value)) {
    const { dataUrl, widthMM, heightMM, baselineRatio } = renderArabicToImage(value, {
      sizePt: size,
      weight: weight === 'bold' ? '700' : '400',
      color
    });
    let drawX = x;
    if (align === 'right') drawX = x - widthMM;
    else if (align === 'center') drawX = x - widthMM / 2;
    const drawY = y - heightMM * baselineRatio;
    doc.addImage(dataUrl, 'PNG', drawX, drawY, widthMM, heightMM);
  } else {
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.setFont('helvetica', weight);
    doc.text(value, x, y, { align });
  }
}

function drawLabelValue(doc, label, value, x, y, opts = {}) {
  drawText(doc, label.toUpperCase(), x, y, { size: 8, color: COLOR_MUTED, weight: 'bold', align: opts.align });
  drawText(doc, value, x, y + 5.2, { size: 11.5, weight: 'bold', align: opts.align });
}

function newDoc() {
  if (!window.jspdf || typeof window.jspdf.jsPDF !== 'function') {
    throw new Error('The PDF library failed to load. Check your internet connection and reload the page.');
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  if (typeof doc.autoTable !== 'function') {
    throw new Error('The PDF table plugin failed to load. Check your internet connection and reload the page.');
  }
  return doc;
}

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
  drawText(doc, invoice.invoiceNumber, PAGE_MARGIN + CONTENT_WIDTH, y + 11, {
    size: 11,
    weight: 'bold',
    align: 'right'
  });
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
    columnStyles: {
      0: { halign: 'left' },
      1: { halign: 'center' },
      2: { halign: 'center', cellWidth: 18 },
      3: { halign: 'center', cellWidth: 34 },
      4: { halign: 'right', cellWidth: 34, fontStyle: 'bold' }
    },
    // Arabic season notes: suppress autoTable's own text draw and stash a
    // pre-rendered image instead (see renderArabicToImage's doc comment) —
    // placed in didDrawCell, once the cell's final x/y/height are known.
    didParseCell(data) {
      if (data.section !== 'body') return;
      const text = Array.isArray(data.cell.raw) ? data.cell.raw.join(' ') : data.cell.raw;
      if (typeof text === 'string' && containsArabic(text)) {
        data.cell.__arabicImage = renderArabicToImage(text, { sizePt: 9.5, weight: '400', color: COLOR_INK });
        data.cell.text = [];
        if (!data.cell.styles.halign || data.cell.styles.halign === 'left') {
          data.cell.styles.halign = 'right';
        }
      }
    },
    didDrawCell(data) {
      if (data.section !== 'body' || !data.cell.__arabicImage) return;
      const { dataUrl, widthMM, heightMM } = data.cell.__arabicImage;
      const padRight = 2;
      const drawX = data.cell.x + data.cell.width - widthMM - padRight;
      const drawY = data.cell.y + (data.cell.height - heightMM) / 2;
      data.doc.addImage(dataUrl, 'PNG', drawX, drawY, widthMM, heightMM);
    }
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
  // The database's revision_number is 1 for a brand-new invoice (so
  // MAX(revision_number)+1 numbering has no off-by-one elsewhere), but staff
  // read a first-time invoice as "Revision 0" and expect its file to have no
  // "-revN" suffix at all — only an actual revision (the 2nd+ download of the
  // same invoice number) should say "Revision 1" and add "-rev1". Shifting
  // the *displayed* number down by one here keeps that DB invariant untouched.
  const displayRevision = invoice.revisionNumber - 1;
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
  const fileName = buildFileName(invoice, displayRevision);
  return { blob, fileName };
}

function todayIsoLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ROMAN_MONTHS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** Windows forbids \ / : * ? " < > | in filenames (macOS/Linux only forbid
 * / , but a guest name typed on one OS still has to survive a download on
 * any other), so a free-text guest name needs these stripped before it can
 * safely become part of a downloaded file's name. */
function sanitizeForFileName(text) {
  return text.replace(/[\\/:*?"<>|]/g, '').trim();
}

/**
 * "ALZOBIDI MOSLEH FAYEZ INV-N-VII-26-0124" (plus " Rev1", "Rev2", … for an
 * actual revision — never "Rev0", since displayRevision 0 means this is the
 * first-ever download of this invoice number). "INV-N-" is a fixed prefix;
 * the roman-numeral month and 2-digit year are *today's* — the moment this
 * PDF is actually being generated/downloaded — not any date stored on the
 * invoice itself, so re-downloading the same saved invoice next month
 * produces a different file name, which is by design (per the villa's own
 * naming convention this mirrors, not a bug). The 4-digit sequence is
 * invoiceNumber's own trailing segment, e.g. "0124" out of "INV-2026-0124".
 */
function buildFileName(invoice, displayRevision) {
  const guestNameUpper = sanitizeForFileName(invoice.guestName).toUpperCase();
  const now = new Date();
  const monthRoman = ROMAN_MONTHS[now.getMonth()];
  const yy = String(now.getFullYear()).slice(-2);
  const seq = invoice.invoiceNumber.split('-').pop();
  const revSuffix = displayRevision > 0 ? ` Rev${displayRevision}` : '';
  return `${guestNameUpper} INV-N-${monthRoman}-${yy}-${seq}${revSuffix}.pdf`;
}
