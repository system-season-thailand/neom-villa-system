# PDF Engine

## Why vector, not a screenshot

The invoice PDF is built almost entirely with jsPDF's drawing primitives —
`doc.text()`, `doc.line()`, `doc.roundedRect()`, and jsPDF-AutoTable for the
charges table. Nothing about the *page layout* is ever rendered to a
`<canvas>` and rasterized (no `html2canvas`, no image snapshot of the HTML
form). That's what makes the text genuinely vector: it stays crisp at any
zoom level, prints cleanly, and the file stays small since text is stored as
text, not pixels. The one deliberate exception is Arabic text — see below —
which *is* rendered via canvas, for reasons that took real investigation to
land on.

The app produces **two** PDFs, both on this same engine:

- the guest **invoice** — [`js/utils/pdfGenerator.js`](js/utils/pdfGenerator.js)
- the Summary tab's **report** — [`js/utils/reportGenerator.js`](js/utils/reportGenerator.js)

Everything they share — the document factory, page geometry, colours, and
the whole Arabic-via-canvas path below — lives in
[`js/utils/pdfCommon.js`](js/utils/pdfCommon.js). That split exists for one
concrete reason: the Arabic handling is subtle enough (see below) that
duplicating it would eventually mean an Arabic guest name rendering
correctly on an invoice and incorrectly on a report.

## Generation workflow

`generateInvoicePdf(invoice)` is an `async` function that takes a plain
object — invoice number, revision number, guest name, check-in/out dates,
nights, villa type, the computed pricing rows, and the total — and:

1. If the invoice contains any Arabic text, waits for the Arabic web font
   to finish loading (see below) — the only `await` in the whole function.
2. Creates an A4 `jsPDF` document (`unit: 'mm'`, 18mm margins).
3. Draws the header (company name/address, "INVOICE" + invoice number),
   guest name, a stay-details panel (check-in / check-out / nights / villa
   type), and a charges table via `doc.autoTable()` — one row per pricing
   period, plus a bold total row.
4. Draws a footer with the revision number and a thank-you line.
5. Returns `{ blob, fileName }` — a `Blob` (`doc.output('blob')`) and a
   suggested filename. Both the footer text and the filename show a
   **displayed** revision number one lower than the real, saved
   `revisionNumber` they're built from — see "Displayed vs. saved revision
   number" below.

This function never touches Supabase — it takes data in, returns a `Blob`
out. That purity is what lets `invoiceTab.js` call it a second time, later,
against a past revision's saved data to reproduce its PDF on demand (see
Revision workflow below), and is also what makes it independently testable.

## Arabic text: rendered via canvas, not as PDF vector text

This is the one place the invoice PDF isn't pure vector, and it's worth
explaining why, because the alternative was tried first and failed for a
genuinely surprising reason.

jsPDF has no text-shaping engine: given a string, it looks up one glyph per
character via the active font's cmap and draws left-to-right at the given
x-position. Arabic requires each letter to be swapped for its isolated/
initial/medial/final "presentation form" glyph depending on its neighbors,
and the run needs to display right-to-left. The standard workaround used
across most jsPDF+Arabic tutorials is to pre-shape the text into those
presentation-form glyphs yourself (in JS, before calling `doc.text()`) and
feed jsPDF an already-reordered string that it can draw naively,
left-to-right, as if it were Latin text.

**This app tried exactly that approach first, and it was wrong.** Testing
against two different, well-regarded Arabic fonts (Amiri and Noto Naskh
Arabic) and two major jsPDF versions (2.5.2, the version this app ships, and
4.2.1) turned up a reproducible bug: specific letter-pair transitions (ي→ل,
ك→ل, م→ل, among others — but not all pairs; ب→ل and ع→م worked correctly)
rendered with a visible gap instead of the connected cursive stroke Arabic
requires. Root-causing it (comparing against real HarfBuzz shaping output
via `uharfbuzz`, testing with the original unsubsetted font files to rule
out this app's own font subsetting) confirmed it wasn't a shaping-table bug
on this app's side — the exact same broken spacing reproduced with stock,
unmodified font files. It's a real gap between how jsPDF positions glyphs
from a CID-embedded TrueType font and what Arabic cursive joining needs.

The fix: stop asking jsPDF to lay out Arabic glyphs at all. Every browser's
`<canvas>` 2D text API goes through the same real text-shaping stack as
ordinary DOM text (HarfBuzz, DirectWrite, or CoreText depending on OS), so
it shapes Arabic correctly by construction — the exact same engine that
already renders the "عميل خاص" option in the Guest By dropdown correctly in
the app's own UI.
`renderArabicToImage()` in `pdfCommon.js` draws a given Arabic string to
an offscreen canvas at 6× the target size (roughly 300+ effective DPI at
normal invoice text sizes) using the **Tajawal** web font — already loaded
by `index.html` for the app's own Arabic UI text — and returns a PNG data
URL sized in PDF millimeters, ready for `doc.addImage()`. `drawText()` and
the `didParseCell`/`didDrawCell` autoTable hooks returned by `tableHooks()`
route Arabic strings through this instead of `doc.text()`; everything else
on the invoice — and on the report — is still pure vector.

**Trade-off, stated plainly:** the Arabic guest name (or an Arabic season
note) is a small embedded image, not selectable/searchable text, inside an
otherwise fully vector, fully text-searchable PDF. Given the alternative was
letters that don't visually connect — objectively wrong output — this is
the right trade to make. See `FUTURE_IMPROVEMENTS.md` if that trade-off ever
needs revisiting (e.g. via a proper WASM text-shaping engine).

Latin/numeric text — the vast majority of every invoice — still uses
jsPDF's built-in Helvetica, one of the 14 standard PDF fonts, which is never
embedded in the file at all. A typical English-only invoice therefore stays
a few KB; only an invoice actually containing Arabic text pays the (small,
per-string) cost of an embedded PNG.

## Table column alignment

Every table in both documents follows one rule, in `columnAlign()`
(`pdfCommon.js`): **first column left, last column right, everything in
between centred.**

It lives there rather than in each table's own `columnStyles` because of a
jsPDF-AutoTable behaviour that is easy to get wrong and hard to spot:

> **AutoTable v3 merges `columnStyles` into body cells only.** Head and foot
> cells are built from `styles` + `headStyles`/`footStyles` and never see
> `columnStyles` at all.

So the obvious way to align a column — `columnStyles: { 2: { halign:
'center' } }` — silently aligns the *numbers* while leaving the *header*
left-aligned above them, out of line. Setting `halign` inside
`tableHooks()`'s `didParseCell` instead reaches head, body and foot alike,
which is the only way to keep a header over its own values.

The practical rule when adding or changing a table: pass `columnCount` to
`tableHooks()` and keep `halign` out of `columnStyles` entirely — use that
for widths, font weights and colours only.

Arabic cells follow the same alignment. `didDrawCell` places the rendered
image at the left edge, centre or right edge of the cell according to the
column's resolved `halign`, so an Arabic guest name lines up under its
header exactly as a Latin one does.

## Revision workflow

No PDF file is ever stored — only the structured data needed to rebuild it.
"Downloading an edited invoice must create a new revision instead of
replacing the previous version" is enforced by **ordering**, not by a
database trigger: the app always **saves before it downloads**, and — since
a brand-new invoice's real number doesn't exist until that save returns it
— it also **builds the PDF from what the save actually returned**, not from
a pre-save guess.

```
validate form
  → insert_invoice_revision() RPC: saves invoice_data (no file); for a
    brand-new invoice this also mints the real invoice number (nextval),
    atomically, as part of the same insert — see DATABASE.md
  → generate PDF blob (client-side, in memory) from the row the RPC
    returned — real invoice number, real revision number
  → only now: trigger the browser's file download of the blob just built
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

### Displayed vs. saved revision number

`neom_pdf.revision_number` (and everywhere else in the app — the Revisions
panel, the Import Invoice modal, toasts) counts from **1**, because that's
what makes `MAX(revision_number) + 1` a correct, off-by-one-free way to
compute the next one (see `insert_invoice_revision()` in `DATABASE.md`).

The PDF itself shows a **different, lower** number — `revisionNumber - 1` —
computed locally inside `generateInvoicePdf()` and used for both the footer
line and the filename, so that:

- The first PDF ever downloaded for an invoice number (`revisionNumber: 1`)
  reads **"Revision 0"** in the footer, and its filename carries no `Rev`
  suffix at all: `ALZOBIDI MOSLEH FAYEZ INV-N-VII-26-0133.pdf`.
- The next download of that same invoice number (`revisionNumber: 2`) reads
  **"Revision 1"**, filename `… INV-N-VII-26-0133 Rev1.pdf`, and so on.

(The `INV-N-<roman month>-<yy>-<seq>` form shown on the page and in the file
name is built by `buildDisplayInvoiceNumber()` from *today's* month/year plus
the stored number's trailing sequence — see its doc comment for why
re-downloading an old invoice next month deliberately produces a different
one.)

This only changes what staff and guests *see* on the file — the database's
own revision numbering, and every in-app list that reads it, is untouched.

## The Summary report

`generateSummaryReportPdf({ from, to, data })` in
[`js/utils/reportGenerator.js`](js/utils/reportGenerator.js) renders the
ملخص (Summary) tab's current period as a single document: the headline
figures — three rows that each answer one question (what the villa sold,
what comes out of that revenue, what it didn't sell) — then
**one date-ordered table covering every night in the period** —
each guest's stay (guest, booker, check-in, check-out, nights, total payment,
and the date the booking was first confirmed) interleaved with the spans the
villa sat empty between them.

Five things about it are deliberate:

- **It takes data, not a date range.** `data` is the exact
  `getBookingSummary()` result the tab already fetched and is displaying, so
  generating a report runs no additional query and the document can never
  disagree with the tab it was generated from. Same purity as
  `generateInvoicePdf()` — data in, `Blob` out, no Supabase.
- **Every date appears exactly once, and the rows tile.** One row's
  check-out is the next row's check-in, so the period can be read straight
  down the table with no arithmetic — a stay, then however long the villa
  stood empty, then the next stay. `buildTimeline()` in `summaryService.js`
  produces that sequence; `Total Nights Sold` + `Empty Dates` always equals
  the number of days in the period. Booked nights that no invoice covers are
  their own kind of row rather than being folded into the empty spans —
  they *are* occupied, they just have no guest, dates or payment of their
  own. Unbooked spans print in red (and italic, so the distinction survives
  greyscale), as does the `Empty Dates` figure that counts them: unsold
  nights are what a reader scans this table to find.
- **Guest rows are the invoice's view, the totals panel is the calendar's.**
  A guest row shows the whole stay as billed, even where it runs past either
  end of the period; the panel above is computed per booked night *inside*
  the period, at that night's rate. The two answer different questions and
  are not expected to tally — see the note above `drawGuestSections()`.
- **It names its own period.** A range covering exactly one whole calendar
  month is titled by that month ("October 2026"), anything else by its two
  end dates; the file name follows the same rule
  (`NEOM VILLA REPORT OCTOBER 2026.pdf`). The caller passes no label.
- **It repeats the tab's pricing caveat.** When any booked night in the
  period has no pricing rule, those nights count toward nights but
  contribute nothing to revenue. The tab flags that in amber; without the
  same line on the page, the PDF would present an understated Total Revenue
  as final — the one way this document could actively mislead someone.

**Nothing is stored.** Like invoices, reports are regenerated on demand
rather than kept as files (see `DATABASE.md` → "Why no Storage bucket"), and
a report has even less reason to be stored: it's a view of live booking
data, not a record issued to a guest.

Page breaks are handled two ways: `autoTable` splits a long table across
pages by itself (repeating its header row), while the fixed-height pieces
around the tables — the section title and each booker's own heading — go
through `ensureSpace()`, so a heading is never stranded alone at the foot of
a page. Page footers are drawn last, once every section is laid out, so
"Page 1 of N" reports the real final count rather than a guess made while
still drawing.
