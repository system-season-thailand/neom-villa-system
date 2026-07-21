# PDF Engine

## Why vector, not a screenshot

The invoice PDF is built entirely with jsPDF's drawing primitives —
`doc.text()`, `doc.line()`, `doc.roundedRect()`, and jsPDF-AutoTable for the
charges table. Nothing is ever rendered to a `<canvas>` and rasterized
(no `html2canvas`, no image snapshot of the HTML form). That's what makes
the text genuinely vector: it stays crisp at any zoom level, prints cleanly,
and the file stays small since text is stored as text, not pixels.

All of this happens in [`js/utils/pdfGenerator.js`](js/utils/pdfGenerator.js).

## Generation workflow

`generateInvoicePdf(invoice)` takes a plain object — invoice number,
revision number, guest name, check-in/out dates, nights, villa type, the
computed pricing rows, and the total — and:

1. Creates an A4 `jsPDF` document (`unit: 'mm'`, 18mm margins).
2. Draws the header (company name/address, "INVOICE" + invoice number),
   guest name, a stay-details panel (check-in / check-out / nights / villa
   type), and a charges table via `doc.autoTable()` — one row per pricing
   period, plus a bold total row.
3. Draws a footer with the revision number and a thank-you line.
4. Returns `{ blob, fileName }` — a `Blob` (`doc.output('blob')`) and a
   suggested filename (`{invoiceNumber}-rev{revisionNumber}.pdf`).

This function is pure with respect to the DOM — it takes data in, returns a
`Blob` out, and never touches Supabase. That purity is what lets
`invoiceTab.js` call it a second time, later, against a past revision's
saved data to reproduce its PDF on demand (see Revision workflow below), and
is also what makes it independently testable.

## Arabic text support

jsPDF has no text-shaping engine: given a string, it looks up one glyph per
character via the active font's cmap and draws left-to-right at the given
x-position. That's correct for Latin text but wrong for Arabic, where each
letter's glyph depends on its neighbors (isolated/initial/medial/final
forms) and the run needs to display right-to-left.

[`js/utils/arabicReshaper.js`](js/utils/arabicReshaper.js) solves this in
two steps, entirely client-side, with no external shaping library:

1. **Shaping** — replaces every Arabic letter with the correct
   presentation-form glyph for its position, using a lookup table
   (`arabicData.js`) generated from the standard Unicode Arabic
   Presentation Forms mapping, including mandatory ligatures (e.g. لا,
   lam+alef → a single glyph). Verified against the reference `arabic_reshaper`
   Python implementation during development.
2. **Reordering** — splits mixed text into script runs, reverses each
   Arabic run's glyph order, and reorders the runs themselves based on
   which script's character appears first (a simplified, first-strong-char
   BiDi rule — sufficient for short strings like a guest name, not a full
   paragraph BiDi implementation).

The output is an ordinary string that jsPDF can draw left-to-right and have
it display correctly.

**The Arabic font is embedded only when actually needed.** `pdfGenerator.js`
checks every piece of text it draws (`containsArabic()`); only if Arabic is
present does it call `doc.addFont(...)` to embed
[`amiriFont.js`](js/utils/amiriFont.js) — a subsetted build of Amiri Regular
(Latin + Arabic + Arabic Presentation Forms only, OpenType shaping/hinting
tables stripped since this app does its own shaping) at ~93KB. A typical
English-only invoice therefore embeds no custom font at all and stays a few
KB; only an invoice using Arabic text (e.g. the "عميل خاص" guest-name chip)
pays that cost, satisfying the "optimized file size" requirement without
sacrificing Arabic support.

Latin/numeric text — the vast majority of every invoice — uses jsPDF's
built-in Helvetica, one of the 14 standard PDF fonts, which is never
embedded in the file at all.

## Revision workflow

No PDF file is ever stored — only the structured data needed to rebuild it.
"Downloading an edited invoice must create a new revision instead of
replacing the previous version" is enforced by **ordering**, not by a
database trigger: the app always **saves before it downloads**.

```
validate form
  → generate PDF blob (client-side, in memory)
  → insert_invoice_revision() RPC: saves invoice_data (no file) and
    atomically assigns the next revision number
  → only now: trigger the browser's file download of the blob already in memory
```

If the save step fails for any reason (network, etc.), the browser download
never fires — the user sees a clear error and can retry. The alternative
ordering (download first, save after) would risk a PDF reaching the user's
disk that was never recorded as a revision, which is exactly the failure
mode the project brief's revision system exists to prevent. See
`saveInvoiceRevision()` in `js/services/invoiceService.js` and
`handleDownload()` in `js/components/invoiceTab.js`.

Loading a past revision ("Open an old revision → Edit it") restores every
field from that revision's stored `invoice_data` JSON snapshot into the
form. Downloading again after edits (or even with no edits) always creates
another new revision — the previous one is never touched.

**Re-downloading a past revision without editing it** (the "PDF" button next
to each entry in the Revisions panel) doesn't fetch anything from Supabase
at all — `regenerateRevisionPdf()` in `invoiceTab.js` calls
`generateInvoicePdf()` again directly against that revision's already-loaded
`invoice_data`, including its originally-stored `generatedAt` timestamp, so
the re-download is byte-for-byte the same content (same dates, guest name,
pricing, and "Generated" date) as what was produced the first time — just
regenerated rather than replayed from a stored file.
