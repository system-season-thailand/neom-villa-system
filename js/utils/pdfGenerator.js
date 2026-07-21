// Builds the invoice PDF entirely with jsPDF's vector drawing primitives
// (text/line/rect calls) — never html2canvas or any raster snapshot — so
// the exported file stays crisp at any zoom/print size and small in bytes.
//
// The Latin/numeric content (the vast majority of every invoice) uses
// jsPDF's built-in Helvetica, which is a "standard 14" PDF font: it is
// never embedded in the file at all, keeping typical invoices only a few
// KB. The Amiri Arabic font is embedded on demand, only when the invoice
// actually contains Arabic text (e.g. the "عميل خاص" guest name), and only
// once per document.
import { formatDisplayDate } from './dateUtils.js';
import { formatIDR, formatNumber } from './format.js';
import { containsArabic, shapeForPdf } from './arabicReshaper.js';
import { AMIRI_REGULAR_BASE64 } from './amiriFont.js';

const PAGE_MARGIN = 18;
const PAGE_WIDTH = 210;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const COLOR_INK = [26, 28, 32];
const COLOR_MUTED = [110, 114, 122];
const COLOR_ACCENT = [181, 98, 47];
const COLOR_BORDER = [225, 227, 231];
const COLOR_SURFACE = [247, 247, 248];

function ensureArabicFont(doc) {
  if (doc.__amiriLoaded) return;
  doc.addFileToVFS('Amiri-Regular.ttf', AMIRI_REGULAR_BASE64);
  doc.addFont('Amiri-Regular.ttf', 'Amiri', 'normal');
  doc.__amiriLoaded = true;
}

/** Draws `text`, transparently switching to the shaped Arabic font when needed. */
function drawText(doc, text, x, y, { size = 10, weight = 'normal', color = COLOR_INK, align = 'left' } = {}) {
  const value = text == null ? '' : String(text);
  doc.setFontSize(size);
  doc.setTextColor(...color);

  if (containsArabic(value)) {
    ensureArabicFont(doc);
    doc.setFont('Amiri', 'normal');
    doc.text(shapeForPdf(value), x, y, { align });
  } else {
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
 * @param {number} invoice.revisionNumber - display-only preview, see peekNextRevisionNumber()
 * @param {string} invoice.guestName
 * @param {string} invoice.checkInDate - ISO date
 * @param {string} invoice.checkOutDate - ISO date
 * @param {number} invoice.nights
 * @param {string} invoice.villaType
 * @param {Array}  invoice.priceRows - [{startDate,endDate,nights,pricePerNight,seasonNote,subtotal}]
 * @param {number} invoice.total
 * @returns {{ blob: Blob, fileName: string }}
 */
export function generateInvoicePdf(invoice) {
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
  drawText(doc, `Generated ${formatDisplayDate(invoice.generatedAt || todayIsoLocal())}`, PAGE_MARGIN + CONTENT_WIDTH, y + 16, {
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
      2: { halign: 'right', cellWidth: 18 },
      3: { halign: 'right', cellWidth: 34 },
      4: { halign: 'right', cellWidth: 34, fontStyle: 'bold' }
    },
    didParseCell(data) {
      const text = Array.isArray(data.cell.raw) ? data.cell.raw.join(' ') : data.cell.raw;
      if (data.section !== 'body') return;
      if (typeof text === 'string' && containsArabic(text)) {
        ensureArabicFont(data.doc);
        data.cell.styles.font = 'Amiri';
        data.cell.text = [shapeForPdf(text)];
        if (!data.cell.styles.halign || data.cell.styles.halign === 'left') {
          data.cell.styles.halign = 'right';
        }
      }
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
  const footerY = 297 - PAGE_MARGIN;
  doc.setDrawColor(...COLOR_BORDER);
  doc.setLineWidth(0.3);
  doc.line(PAGE_MARGIN, footerY - 10, PAGE_MARGIN + CONTENT_WIDTH, footerY - 10);
  drawText(doc, `Revision ${invoice.revisionNumber}`, PAGE_MARGIN, footerY - 4, { size: 8, color: COLOR_MUTED });
  drawText(doc, 'Thank you for staying with Neom Villa.', PAGE_MARGIN + CONTENT_WIDTH, footerY - 4, {
    size: 8,
    color: COLOR_MUTED,
    align: 'right'
  });

  const blob = doc.output('blob');
  const fileName = `${invoice.invoiceNumber}-rev${invoice.revisionNumber}.pdf`;
  return { blob, fileName };
}

function todayIsoLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
