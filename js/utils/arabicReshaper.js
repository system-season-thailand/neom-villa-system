// Detects Arabic text so pdfGenerator.js knows when to route a string
// through renderArabicToImage() (canvas-rendered, correctly shaped by the
// browser's own text engine) instead of drawing it as jsPDF vector text.
// See the big comment above renderArabicToImage() in pdfGenerator.js for why
// jsPDF itself is not used to lay out Arabic glyphs.
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
