// Builds the Summary tab's report PDF: the headline totals for the selected
// period, then one date-ordered table covering every night in it — each
// guest's stay, and the spans the villa sat empty between them.
//
// A stay row is the *invoice's* own account of it — check-in, check-out,
// nights, total payment — plus the date that booking was first confirmed.
// That's a different lens from the figures in the totals panel above it,
// which come from the booking calendar and the nightly rates; see the note
// above drawTimelineTable() for why the two can legitimately differ.
//
// Same engine and conventions as the guest invoice: vector Helvetica for all
// Latin/numeric text, with Arabic routed through the shared canvas-rendering
// path in pdfCommon.js (booker and guest names can both be Arabic). Like
// pdfGenerator.js, this takes data in and returns a Blob out — it never
// touches Supabase, so it's driven entirely by whatever the tab already
// fetched and is showing.
import { formatDisplayDate, monthLabel, parseISO, toISO } from './dateUtils.js';
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
  COLOR_WARNING,
  COLOR_DANGER,
  drawText,
  drawLabelValue,
  ensureArabicWebFontReady,
  tableHooks,
  newDoc,
  sanitizeForFileName,
  todayIsoLocal
} from './pdfCommon.js';

const UNATTRIBUTED_LABEL = 'Booked - no matching invoice';
const EMPTY_LABEL = 'Empty - not booked';
// Italic as well as red: an unbooked span is a gap in the record, not a row
// of data, and the slant keeps that legible even in greyscale print.
const EMPTY_ROW_STYLE = { textColor: COLOR_DANGER, fontStyle: 'italic' };
const EMPTY_CELL = '—';

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
 * @param {object} params.data - the getBookingSummary() result currently rendered
 * @returns {Promise<{ blob: Blob, fileName: string }>}
 */
export async function generateSummaryReportPdf({ from, to, data }) {
  if (hasArabicContent(data)) {
    await ensureArabicWebFontReady();
  }

  const period = periodLabel(from, to);

  const doc = newDoc();
  doc.setProperties({
    title: `Neom Villa Report ${period}`,
    subject: 'Neom Villa booking and revenue report',
    author: 'Neom Villa',
    creator: 'Neom Villa Staff Console'
  });

  let y = drawHeader(doc, period);
  y = drawTotalsPanel(doc, y, data);
  y = drawMissingPriceNote(doc, y, data);
  drawTimelineTable(doc, y, data.timeline);
  drawPageFooters(doc);

  return {
    blob: doc.output('blob'),
    fileName: `${sanitizeForFileName(`NEOM VILLA REPORT ${period}`).toUpperCase()}.pdf`
  };
}

/**
 * What to call the period being reported on. A range covering exactly one
 * whole calendar month reads as that month's name ("October 2026") rather
 * than as its two end dates, since that's how anyone actually refers to it;
 * anything else falls back to the literal range.
 */
function periodLabel(from, to) {
  const start = parseISO(from);
  const end = parseISO(to);
  const lastOfStartMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();

  const isWholeMonth =
    start.getDate() === 1 &&
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    end.getDate() === lastOfStartMonth;

  return isWholeMonth
    ? monthLabel(start.getFullYear(), start.getMonth())
    : `${formatDisplayDate(from)} - ${formatDisplayDate(to)}`;
}

function hasArabicContent(data) {
  return data.timeline.some((row) => containsArabic(row.guestName || '') || containsArabic(row.bookedBy || ''));
}

function drawHeader(doc, period) {
  const y = PAGE_MARGIN;

  drawText(doc, 'NEOM VILLA', PAGE_MARGIN, y + 4, { size: 18, weight: 'bold' });
  drawText(doc, 'Batu Layang, Kec. Cisarua,', PAGE_MARGIN, y + 10, { size: 8.5, color: COLOR_MUTED });
  drawText(doc, 'Kabupaten Bogor, Jawa Barat 16750', PAGE_MARGIN, y + 14.5, { size: 8.5, color: COLOR_MUTED });

  drawText(doc, 'REPORT', PAGE_MARGIN + CONTENT_WIDTH, y + 4, {
    size: 18,
    weight: 'bold',
    color: COLOR_ACCENT,
    align: 'right'
  });
  drawText(doc, period, PAGE_MARGIN + CONTENT_WIDTH, y + 11, {
    size: 11,
    weight: 'bold',
    align: 'right'
  });
  drawText(doc, `Generated: ${formatDisplayDate(todayIsoLocal())}`, PAGE_MARGIN + CONTENT_WIDTH, y + 16, {
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

/**
 * The headline figures, in three rows of up to three, each row one subject:
 * what the villa sold, what comes out of that revenue, and what it didn't
 * sell. Grouped across rather than down so that reading the panel the normal
 * way — left to right, line by line — reads one subject at a time.
 *
 * Colour marks the two things worth finding at a glance: net revenue in the
 * brand accent as the number the report exists to arrive at, and the whole
 * unsold row in the same red as the unbooked rows further down, so the
 * headline and the detail read as one story.
 */
function drawTotalsPanel(doc, y, data) {
  const rows = [
    [
      ['Total Nights Sold', String(data.totalNights)],
      ['Total Revenue (IDR)', formatNumber(data.totalRevenue)],
      ['Net Revenue (IDR)', formatNumber(data.totalNetRevenue), COLOR_ACCENT]
    ],
    [
      ['Commissions 9% (IDR)', formatNumber(data.totalCommission)],
      ['Area Guard 1% (IDR)', formatNumber(data.totalAreaGuard)],
      ['Villa Guard 50K (IDR)', formatNumber(data.totalVillaGuard)]
    ],
    [
      ['Empty Dates', String(data.emptyNights), COLOR_DANGER],
      ['Total Not Booked (IDR)', formatNumber(data.emptyNightsValue), COLOR_DANGER]
    ]
  ];

  const rowH = 15;
  const panelH = rowH * rows.length + 8;
  doc.setFillColor(...COLOR_SURFACE);
  doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, panelH, 2, 2, 'F');

  // Every row sits on the same three-column grid, so the figures line up
  // vertically even where a row is short of a third entry.
  const perRow = Math.max(...rows.map((r) => r.length));
  const colW = CONTENT_WIDTH / perRow;
  rows.forEach((cells, row) => {
    cells.forEach(([label, value, color], col) => {
      drawLabelValue(doc, label, value, PAGE_MARGIN + colW * col + 6, y + 7 + rowH * row, {
        size: 10,
        color: color || COLOR_INK
      });
    });
  });

  return y + panelH + 12;
}

/**
 * A booked night with no pricing rule covering it counts toward nights but
 * contributes nothing to revenue (see getBookingSummary). On screen the tab
 * flags that in amber; without the same caveat here the PDF would quietly
 * present an understated Total Revenue as final — the one way this document
 * could actively mislead someone, so it says so on its face.
 */
function drawMissingPriceNote(doc, y, data) {
  const notes = [];
  if (data.missingPriceNights) {
    const n = data.missingPriceNights;
    notes.push(
      `${n} booked night${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} no pricing rule` +
        ` and ${n === 1 ? 'is' : 'are'} excluded from the revenue figures above`
    );
  }
  if (data.emptyMissingPriceNights) {
    const n = data.emptyMissingPriceNights;
    notes.push(
      `${n} unbooked night${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} no pricing rule` +
        ` and ${n === 1 ? 'is' : 'are'} excluded from Total Not Booked`
    );
  }
  if (!notes.length) return y;

  drawText(doc, `Note: ${notes.join('; ')}.`, PAGE_MARGIN, y, { size: 8.5, color: COLOR_WARNING });
  return y + 8;
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

/**
 * One table covering the whole period, in date order, with every date
 * accounted for exactly once — a guest's stay, booked nights no invoice
 * covers, or a span with no booking at all. See buildTimeline() in
 * summaryService.js for how the rows are formed.
 *
 * Because consecutive rows tile (one row's check-out is the next row's
 * check-in), the period can be read straight down the table: each stay is
 * followed by however long the villa then sat empty before the next one.
 *
 * Stay rows report the *invoice's* own dates, nights and payment, so a stay
 * running past either end of the period is shown as the guest was actually
 * billed for it. That means these payments aren't expected to add up to the
 * revenue figure in the panel above, which is computed the other way round:
 * per booked calendar night inside the period, at that night's rate. They
 * answer different questions and both are wanted.
 */
function drawTimelineTable(doc, y, timeline) {
  y = ensureSpace(doc, y, 34);
  y = drawSectionTitle(doc, y, 'Guests & Empty Dates', 'All amounts in IDR');
  y += 3;

  if (!timeline.length) {
    drawText(doc, 'Nothing recorded for this period.', PAGE_MARGIN, y + 6, { size: 9.5, color: COLOR_MUTED });
    return;
  }

  // Row indices of the unbooked spans, so tableHooks can colour them — a
  // night nobody paid for is the thing a reader scans this table to find, so
  // it's called out in red rather than played down.
  const emptyRows = new Set();
  const body = timeline.map((row, index) => {
    if (row.kind === 'empty') emptyRows.add(index);
    return [
      rowLabel(row),
      row.kind === 'empty' ? EMPTY_CELL : row.bookedBy || EMPTY_CELL,
      formatDisplayDate(row.start),
      formatDisplayDate(row.end),
      String(row.nights),
      row.kind === 'stay' && row.totalPayment != null ? formatNumber(row.totalPayment) : EMPTY_CELL,
      row.kind === 'stay' ? formatConfirmedDate(row.confirmedAt) : EMPTY_CELL
    ];
  });

  doc.autoTable({
    ...BASE_TABLE_STYLES,
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Guest', 'Guest By', 'Check-in', 'Check-out', 'Nights', 'Total Payment', 'Confirmed']],
    body,
    // Widths and weights only — halign comes from tableHooks() so the
    // headers stay in line with their own values. See pdfCommon.js.
    columnStyles: {
      0: { cellWidth: 42 },
      1: { cellWidth: 24 },
      2: { cellWidth: 23 },
      3: { cellWidth: 23 },
      4: { cellWidth: 12 },
      5: { cellWidth: 26, fontStyle: 'bold' },
      6: { cellWidth: 24 }
    },
    ...tableHooks({
      columnCount: 7,
      sizePt: 9,
      rowStyle: (index) => (emptyRows.has(index) ? EMPTY_ROW_STYLE : null)
    })
  });
}

/** `confirmedAt` is a timestamptz; rendering it through the local calendar
 * date (rather than slicing the UTC string) keeps a booking confirmed late
 * in the evening on the day staff actually made it. */
function formatConfirmedDate(confirmedAt) {
  if (!confirmedAt) return EMPTY_CELL;
  const when = new Date(confirmedAt);
  return Number.isNaN(when.getTime()) ? EMPTY_CELL : formatDisplayDate(toISO(when));
}

function rowLabel(row) {
  if (row.kind === 'empty') return EMPTY_LABEL;
  if (row.kind === 'unattributed') return UNATTRIBUTED_LABEL;
  return row.guestName;
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
    drawText(doc, 'Neom Villa — internal report', PAGE_MARGIN, footerY - 4, { size: 8, color: COLOR_MUTED });
    drawText(doc, `Page ${page} of ${pageCount}`, PAGE_MARGIN + CONTENT_WIDTH, footerY - 4, {
      size: 8,
      color: COLOR_MUTED,
      align: 'right'
    });
  }
}
