// Shared jsPDF plumbing used by every PDF this app produces — the guest
// invoice (pdfGenerator.js) and the Summary tab's statement
// (statementGenerator.js).
//
// This module exists because both documents need the exact same two
// non-obvious things: a document factory that fails loudly when the CDN
// libraries didn't load, and the Arabic-via-canvas text path described at
// length above renderArabicToImage() below. Duplicating either one would
// mean an Arabic guest name rendering correctly on an invoice and
// incorrectly on a statement.
import { containsArabic } from './arabicReshaper.js';

export const PAGE_MARGIN = 18;
export const PAGE_WIDTH = 210;
export const PAGE_HEIGHT = 297;
export const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

export const COLOR_INK = [26, 28, 32];
export const COLOR_MUTED = [110, 114, 122];
export const COLOR_ACCENT = [181, 98, 47];
export const COLOR_BORDER = [225, 227, 231];
export const COLOR_SURFACE = [247, 247, 248];

const MM_PER_PT = 25.4 / 72;
// Render at a high internal resolution so the embedded image stays crisp
// even when the PDF is zoomed in or printed (roughly 300+ effective DPI for
// normal document text sizes).
const ARABIC_CANVAS_SCALE = 6;
const ARABIC_FONT_FAMILY = 'Tajawal'; // already loaded by index.html for the app's own Arabic UI text

/**
 * Arabic text is the one thing on these documents jsPDF cannot be trusted to
 * draw correctly. jsPDF has no text-shaping engine, so the standard
 * workaround (used throughout most jsPDF+Arabic tutorials) is to pre-shape
 * the text into Unicode presentation-form glyphs yourself and hand jsPDF an
 * already-reordered string. That was this app's original approach — but
 * testing (across two different well-regarded Arabic fonts and two major
 * jsPDF versions) turned up a real, reproducible bug: specific letter pairs
 * render with a visible gap instead of the connected cursive stroke Arabic
 * requires, because jsPDF/the font's presentation-form glyphs don't position
 * correctly relative to each other in that code path. It isn't a shaping-
 * table bug on this app's side — the same broken spacing reproduces with the
 * *original, unsubsetted* font files.
 *
 * The reliable fix is to stop asking jsPDF to lay the glyphs out at all.
 * Every browser's <canvas> 2D text API goes through the same real text-
 * shaping stack as normal DOM text (HarfBuzz/DirectWrite/CoreText
 * depending on OS), so it renders Arabic correctly by construction. This
 * function draws the given Arabic string to an offscreen canvas at high
 * resolution and returns a PNG data URL plus its size in PDF millimeters,
 * for embedding with doc.addImage(). Everything else on these documents is
 * still pure vector text — only the Arabic run itself becomes a (small,
 * high-DPI) image. See PDF_ENGINE.md for the trade-off this implies for
 * copy/paste and text search.
 */
export function renderArabicToImage(text, { sizePt, weight = '400', color = COLOR_INK } = {}) {
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
 * first Arabic document of a session could silently fall back to a generic
 * serif and measure/draw incorrectly. */
export async function ensureArabicWebFontReady() {
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
export function drawText(doc, text, x, y, { size = 10, weight = 'normal', color = COLOR_INK, align = 'left' } = {}) {
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

export function drawLabelValue(doc, label, value, x, y, opts = {}) {
  drawText(doc, label.toUpperCase(), x, y, { size: 8, color: COLOR_MUTED, weight: 'bold', align: opts.align });
  drawText(doc, value, x, y + 5.2, {
    size: opts.size || 11.5,
    weight: 'bold',
    align: opts.align,
    color: opts.color || COLOR_INK
  });
}

/**
 * The autoTable equivalent of drawText's Arabic branch. autoTable draws its
 * own cell text, so an Arabic cell instead gets its text suppressed in
 * didParseCell (which stashes a pre-rendered image on the cell) and the
 * image placed in didDrawCell, once the cell's final x/y/height are known.
 * Spread the returned object into an autoTable() config.
 */
export function arabicTableHooks({ sizePt = 9.5, color = COLOR_INK, sections = ['body'] } = {}) {
  return {
    didParseCell(data) {
      if (!sections.includes(data.section)) return;
      const text = Array.isArray(data.cell.raw) ? data.cell.raw.join(' ') : data.cell.raw;
      if (typeof text === 'string' && containsArabic(text)) {
        data.cell.__arabicImage = renderArabicToImage(text, { sizePt, weight: '400', color });
        data.cell.text = [];
        if (!data.cell.styles.halign || data.cell.styles.halign === 'left') {
          data.cell.styles.halign = 'right';
        }
      }
    },
    didDrawCell(data) {
      if (!sections.includes(data.section) || !data.cell.__arabicImage) return;
      const { dataUrl, widthMM, heightMM } = data.cell.__arabicImage;
      const padRight = 2;
      const drawX = data.cell.x + data.cell.width - widthMM - padRight;
      const drawY = data.cell.y + (data.cell.height - heightMM) / 2;
      data.doc.addImage(dataUrl, 'PNG', drawX, drawY, widthMM, heightMM);
    }
  };
}

export function newDoc() {
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

/** Windows forbids \ / : * ? " < > | in filenames (macOS/Linux only forbid
 * / , but a guest name typed on one OS still has to survive a download on
 * any other), so free text needs these stripped before it can safely become
 * part of a downloaded file's name. */
export function sanitizeForFileName(text) {
  return String(text ?? '').replace(/[\\/:*?"<>|]/g, '').trim();
}

export function todayIsoLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
