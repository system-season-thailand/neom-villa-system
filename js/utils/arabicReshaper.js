// Minimal Arabic text shaper + simplified bidi reordering, purpose-built for
// drawing short Arabic strings (guest names, season notes) with jsPDF.
//
// jsPDF has no text-shaping engine: it looks up one glyph per character via
// the font's cmap and draws left-to-right at the given x position. Real
// Arabic requires each letter to be swapped for its isolated/initial/
// medial/final "presentation form" glyph depending on its neighbours, and
// the whole run needs to be reordered for right-to-left display. This module
// does both steps up front so the *output* string can be handed to
// `doc.text()` as if it were an ordinary left-to-right string.
//
// The shaping tables (ARABIC_LETTERS, LAM_ALEF_LIGATURES) are generated from
// the reference Unicode Arabic Presentation Forms mapping — see arabicData.js.
import { ARABIC_LETTERS, LAM_ALEF_LIGATURES } from './arabicData.js';

const ISOLATED = 0;
const INITIAL = 1;
const MEDIAL = 2;
const FINAL = 3;

function isArabicCodePoint(cp) {
  return cp >= 0x0600 && cp <= 0x06ff;
}

export function containsArabic(text) {
  if (!text) return false;
  for (const ch of text) {
    if (isArabicCodePoint(ch.codePointAt(0))) return true;
  }
  return false;
}

function canJoinNext(entry) {
  return !!(entry && (entry[INITIAL] || entry[MEDIAL]));
}

function canJoinPrev(entry) {
  return !!(entry && (entry[MEDIAL] || entry[FINAL]));
}

/** Shapes one script-homogeneous Arabic run (no run-splitting needed inside). */
function shapeRun(run) {
  const chars = Array.from(run);
  const units = [];

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    const ligKey = next ? c + next : null;
    if (ligKey && LAM_ALEF_LIGATURES[ligKey]) {
      units.push({ entry: LAM_ALEF_LIGATURES[ligKey], raw: ligKey });
      i++; // consumed two source characters as one unit
    } else {
      units.push({ entry: ARABIC_LETTERS[c] || null, raw: c });
    }
  }

  const shaped = units.map((unit, i) => {
    if (!unit.entry) return unit.raw;
    const prev = units[i - 1];
    const next = units[i + 1];
    const connectsFromPrev = !!(prev && canJoinNext(prev.entry) && canJoinPrev(unit.entry));
    const connectsToNext = !!(next && canJoinNext(unit.entry) && canJoinPrev(next.entry));

    let form = ISOLATED;
    if (connectsFromPrev && connectsToNext && unit.entry[MEDIAL]) form = MEDIAL;
    else if (connectsFromPrev && unit.entry[FINAL]) form = FINAL;
    else if (connectsToNext && unit.entry[INITIAL]) form = INITIAL;

    return unit.entry[form] || unit.entry[ISOLATED] || unit.raw;
  });

  return shaped.join('');
}

function isLatinLetter(ch) {
  return /[A-Za-z]/.test(ch);
}

/** First strong-directional character wins, per the Unicode BiDi default (P2/P3). */
function detectBaseDirection(text) {
  for (const ch of text) {
    if (isArabicCodePoint(ch.codePointAt(0))) return 'rtl';
    if (isLatinLetter(ch)) return 'ltr';
  }
  return 'rtl';
}

/**
 * Shapes and reorders `text` so it can be drawn left-to-right by jsPDF.
 * Non-Arabic runs (Latin words, digits, punctuation) are left untouched
 * internally. The run carrying the first strong-directional character sets
 * the base direction: an Arabic-first string reverses the run order (RTL
 * paragraph), a Latin-first string keeps run order and only mirrors the
 * embedded Arabic run(s) in place (LTR paragraph with an RTL insertion) —
 * this covers the cases relevant here without a full Unicode BiDi pass.
 */
export function shapeForPdf(text) {
  if (!text) return '';
  if (!containsArabic(text)) return text;

  const chars = Array.from(text);
  const runs = [];
  let current = null;
  for (const c of chars) {
    const isAr = isArabicCodePoint(c.codePointAt(0));
    if (current && current.isAr === isAr) {
      current.text += c;
    } else {
      current = { isAr, text: c };
      runs.push(current);
    }
  }

  const shapedRuns = runs.map((run) => {
    if (!run.isAr) return run.text;
    const shaped = shapeRun(run.text);
    return Array.from(shaped).reverse().join('');
  });

  const baseDirection = detectBaseDirection(text);
  return baseDirection === 'rtl' ? shapedRuns.reverse().join('') : shapedRuns.join('');
}
