// Builds the Summary tab's statement PDF — everything that tab shows for the
// currently selected date range, as one downloadable document: the headline
// totals, the per-booker breakdown, each booker's own per-guest detail (the
// same data behind the tab's "More Details" buttons), and the per-month
// gross/net figures.
//
// Same engine and conventions as the guest invoice: vector Helvetica for all
// Latin/numeric text, with Arabic routed through the shared canvas-rendering
// path in pdfCommon.js (booker and guest names can both be Arabic). Like
// pdfGenerator.js, this takes data in and returns a Blob out — it never
// touches Supabase, so it's driven entirely by whatever the tab already
// fetched and is showing.
import { formatDisplayDate, monthLabel } from './dateUtils.js';
import { formatNumber } from './format.js';
import { containsArabic } from './arabicReshaper.js';
import {
  PAGE_MARGIN,
  PAGE_HEIGHT,
  CONTENT_WIDTH,
  COLOR_INK,
  COLOR_MUTED,
  COLOR_ACCENT,
  COLOR_BORDER,
  COLOR_SURFACE,
  drawText,
  drawLabelValue,
  ensureArabicWebFontReady,
  arabicTableHooks,
  newDoc,
  sanitizeForFileName,
  todayIsoLocal
} from './pdfCommon.js';

const UNATTRIBUTED_LABEL = 'No matching invoice';

const BASE_TABLE_STYLES = {
  theme: 'plain',
  styles: {
    font: 'helvetica',
    fontSize: 9,
    textColor: COLOR_INK,
    cellPadding: { top: 2.6, bottom: 2.6, left: 2, right: 2 },
    lineColor: COLOR_BORDER,
    lineWidth: 0.2,
    overflow: 'linebreak'
  },
  headStyles: {
    fontStyle: 'bold',
    fontSize: 7.5,
    textColor: COLOR_MUTED,
    fillColor: false,
    lineWidth: { bottom: 0.6 },
    lineColor: COLOR_INK
  },
  bodyStyles: { lineWidth: { bottom: 0.2 } }
};

/**
 * @param {object} params
 * @param {string} params.from - ISO date, inclusive start of the range on screen
 * @param {string} params.to   - ISO date, inclusive end of the range on screen
 * @param {string} [params.rangeLabel] - what the tab itself calls this range ("This Month", "September 2026")
 * @param {object} params.data - the getBookingSummary() result currently rendered
 * @returns {Promise<{ blob: Blob, fileName: string }>}
 */
export async function generateSummaryStatementPdf({ from, to, rangeLabel = '', data }) {
  if (hasArabicContent(data)) {
    await ensureArabicWebFontReady();
  }

  const doc = newDoc();
  doc.setProperties({
    title: `Neom Villa Statement ${formatDisplayDate(from)} - ${formatDisplayDate(to)}`,
    subject: 'Neom Villa booking and revenue statement',
    author: 'Neom Villa',
    creator: 'Neom Villa Staff Console'
  });

  let y = drawHeader(doc, { from, to, rangeLabel });
  y = drawTotalsPanel(doc, y, data);
  y = drawBookerTable(doc, y, data.byBooker);
  y = drawGuestSections(doc, y, data.byBooker);
  drawMonthTable(doc, y, data.byMonth);
  drawPageFooters(doc);

  return {
    blob: doc.output('blob'),
    fileName: buildFileName(from, to)
  };
}

function hasArabicContent(data) {
  return data.byBooker.some(
    (b) => containsArabic(b.bookedBy) || b.guests.some((g) => containsArabic(g.guestName || ''))
  );
}

function drawHeader(doc, { from, to, rangeLabel }) {
  const y = PAGE_MARGIN;

  drawText(doc, 'NEOM VILLA', PAGE_MARGIN, y + 4, { size: 18, weight: 'bold' });
  drawText(doc, 'Batu Layang, Kec. Cisarua,', PAGE_MARGIN, y + 10, { size: 8.5, color: COLOR_MUTED });
  drawText(doc, 'Kabupaten Bogor, Jawa Barat 16750', PAGE_MARGIN, y + 14.5, { size: 8.5, color: COLOR_MUTED });

  drawText(doc, 'STATEMENT', PAGE_MARGIN + CONTENT_WIDTH, y + 4, {
    size: 18,
    weight: 'bold',
    color: COLOR_ACCENT,
    align: 'right'
  });
  drawText(doc, `${formatDisplayDate(from)} - ${formatDisplayDate(to)}`, PAGE_MARGIN + CONTENT_WIDTH, y + 11, {
    size: 11,
    weight: 'bold',
    align: 'right'
  });
  const generated = `Generated: ${formatDisplayDate(todayIsoLocal())}`;
  drawText(doc, rangeLabel ? `${rangeLabel} · ${generated}` : generated, PAGE_MARGIN + CONTENT_WIDTH, y + 16, {
    size: 8.5,
    color: COLOR_MUTED,
    align: 'right'
  });

  const lineY = y + 24;
  doc.setDrawColor(...COLOR_BORDER);
  doc.setLineWidth(0.4);
  doc.line(PAGE_MARGIN, lineY, PAGE_MARGIN + CONTENT_WIDTH, lineY);

  return lineY + 10;
}

/** The six headline figures, in the same reading order the tab presents them:
 * what was sold on the top row, what comes out of it on the bottom row. */
function drawTotalsPanel(doc, y, data) {
  const rowH = 15;
  const panelH = rowH * 2 + 8;
  doc.setFillColor(...COLOR_SURFACE);
  doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, panelH, 2, 2, 'F');

  const colW = CONTENT_WIDTH / 3;
  const cells = [
    ['Total Nights Sold', String(data.totalNights)],
    ['Total Revenue (IDR)', formatNumber(data.totalRevenue)],
    ['Commissions 9% (IDR)', formatNumber(data.totalCommission)],
    ['Area Guard 1% (IDR)', formatNumber(data.totalAreaGuard)],
    ['Villa Guard 50K (IDR)', formatNumber(data.totalVillaGuard)],
    ['Net Revenue (IDR)', formatNumber(data.totalNetRevenue)]
  ];

  cells.forEach(([label, value], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = PAGE_MARGIN + colW * col + 6;
    const cy = y + 7 + rowH * row;
    // Net revenue is the number the whole statement exists to arrive at, so
    // it's the one figure carrying the brand accent rather than plain ink.
    const isNet = label.startsWith('Net Revenue');
    drawLabelValue(doc, label, value, x, cy, { size: 10.5, color: isNet ? COLOR_ACCENT : COLOR_INK });
  });

  return y + panelH + 12;
}

function drawSectionTitle(doc, y, title, subtitle) {
  drawText(doc, title.toUpperCase(), PAGE_MARGIN, y, { size: 9, weight: 'bold', color: COLOR_MUTED });
  if (subtitle) {
    drawText(doc, subtitle, PAGE_MARGIN + CONTENT_WIDTH, y, { size: 8, color: COLOR_MUTED, align: 'right' });
  }
  return y + 4;
}

/** Starts a new page when what's about to be drawn wouldn't fit on this one.
 * autoTable splits long tables across pages by itself; this is for the fixed-
 * height things around them (section titles, per-booker headings) that would
 * otherwise be stranded alone at the bottom of a page. */
function ensureSpace(doc, y, needed) {
  if (y + needed > PAGE_HEIGHT - PAGE_MARGIN - 12) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return y;
}

function drawBookerTable(doc, y, byBooker) {
  y = ensureSpace(doc, y, 30);
  y = drawSectionTitle(doc, y, 'By Booker', 'All amounts in IDR');

  if (!byBooker.length) {
    drawText(doc, 'No bookings in this range.', PAGE_MARGIN, y + 6, { size: 9.5, color: COLOR_MUTED });
    return y + 14;
  }

  doc.autoTable({
    ...BASE_TABLE_STYLES,
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Booker', 'Nights', 'Revenue', 'Commission (9%)', 'Area Guard (1%)', 'Villa Guard (50K)']],
    body: byBooker.map((b) => [
      b.bookedBy,
      String(b.nights),
      formatNumber(b.revenue),
      formatNumber(b.commission),
      formatNumber(b.areaGuard),
      formatNumber(b.villaGuard)
    ]),
    columnStyles: {
      0: { halign: 'left', cellWidth: 44 },
      1: { halign: 'center', cellWidth: 15 },
      2: { halign: 'right', cellWidth: 29, fontStyle: 'bold' },
      3: { halign: 'right', cellWidth: 29 },
      4: { halign: 'right', cellWidth: 28, textColor: COLOR_MUTED },
      5: { halign: 'right', cellWidth: 29, textColor: COLOR_MUTED }
    },
    ...arabicTableHooks({ sizePt: 9 })
  });

  return doc.lastAutoTable.finalY + 10;
}

/** One small table per booker naming the guests behind their nights — the
 * printed form of the tab's "More Details" expansion. */
function drawGuestSections(doc, y, byBooker) {
  const withGuests = byBooker.filter((b) => b.guests.length);
  if (!withGuests.length) return y;

  y = ensureSpace(doc, y, 34);
  y = drawSectionTitle(doc, y, 'Guest Detail by Booker', 'All amounts in IDR');
  y += 3;

  for (const booker of withGuests) {
    // Enough room for the booker's own heading plus a header row and at
    // least one guest line, so a heading never ends up alone at a page break.
    y = ensureSpace(doc, y, 26);
    drawText(doc, booker.bookedBy, PAGE_MARGIN, y + 3, { size: 10, weight: 'bold' });
    drawText(
      doc,
      `${booker.nights} night${booker.nights === 1 ? '' : 's'} · ${booker.guests.length} guest${booker.guests.length === 1 ? '' : 's'}`,
      PAGE_MARGIN + CONTENT_WIDTH,
      y + 3,
      { size: 8, color: COLOR_MUTED, align: 'right' }
    );

    doc.autoTable({
      ...BASE_TABLE_STYLES,
      startY: y + 6,
      margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
      head: [['Guest', 'Nights', 'Revenue', 'Commission (9%)']],
      body: booker.guests.map((g) => [
        guestDisplayName(g),
        String(g.nights),
        formatNumber(g.revenue),
        formatNumber(g.commission)
      ]),
      columnStyles: {
        0: { halign: 'left', cellWidth: 90 },
        1: { halign: 'center', cellWidth: 18 },
        2: { halign: 'right', cellWidth: 33 },
        3: { halign: 'right', cellWidth: 33, fontStyle: 'bold' }
      },
      ...arabicTableHooks({ sizePt: 9 })
    });

    y = doc.lastAutoTable.finalY + 8;
  }

  return y + 2;
}

function guestDisplayName(guest) {
  if (!guest.guestName) return UNATTRIBUTED_LABEL;
  return guest.invoiceNumbers.length
    ? `${guest.guestName}  (${guest.invoiceNumbers.join(', ')})`
    : guest.guestName;
}

function drawMonthTable(doc, y, byMonth) {
  y = ensureSpace(doc, y, 30);
  y = drawSectionTitle(doc, y, 'By Month — All Bookers', 'Net = revenue less 9%, 1% and 50K per night');

  if (!byMonth.length) {
    drawText(doc, 'No bookings in this range.', PAGE_MARGIN, y + 6, { size: 9.5, color: COLOR_MUTED });
    return;
  }

  doc.autoTable({
    ...BASE_TABLE_STYLES,
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Month', 'Nights', 'Total Revenue (IDR)', 'Net Revenue (IDR)']],
    body: byMonth.map((m) => [
      monthKeyLabel(m.month),
      String(m.nights),
      formatNumber(m.revenue),
      formatNumber(m.netRevenue)
    ]),
    columnStyles: {
      0: { halign: 'left', cellWidth: 54 },
      1: { halign: 'center', cellWidth: 22 },
      2: { halign: 'right', cellWidth: 49 },
      3: { halign: 'right', cellWidth: 49, fontStyle: 'bold' }
    },
    ...arabicTableHooks({ sizePt: 9 })
  });
}

/** Added after every section is laid out, so the "of N" is the real final
 * page count rather than a guess made while still drawing. */
function drawPageFooters(doc) {
  const pageCount = doc.getNumberOfPages();
  const footerY = PAGE_HEIGHT - PAGE_MARGIN;

  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setDrawColor(...COLOR_BORDER);
    doc.setLineWidth(0.3);
    doc.line(PAGE_MARGIN, footerY - 10, PAGE_MARGIN + CONTENT_WIDTH, footerY - 10);
    drawText(doc, 'Neom Villa — internal statement', PAGE_MARGIN, footerY - 4, { size: 8, color: COLOR_MUTED });
    drawText(doc, `Page ${page} of ${pageCount}`, PAGE_MARGIN + CONTENT_WIDTH, footerY - 4, {
      size: 8,
      color: COLOR_MUTED,
      align: 'right'
    });
  }
}

function monthKeyLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return monthLabel(y, m - 1);
}

/** "NEOM VILLA STATEMENT 1 SEP 2026 - 30 SEP 2026.pdf" — the range itself is
 * the identity here (there's no statement number to key off), so it reads the
 * same way the villa's invoice file names do: what it is, then which one. */
function buildFileName(from, to) {
  const range = `${formatDisplayDate(from)} - ${formatDisplayDate(to)}`;
  return `${sanitizeForFileName(`NEOM VILLA STATEMENT ${range}`)}.pdf`;
}
