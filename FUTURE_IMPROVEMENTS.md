# Future Improvements

Honest list of trade-offs made to hit the current scope, and what to revisit
if the app's usage grows beyond "one small trusted staff team."

## Security

- **Add Supabase Auth if the URL ever leaves trusted hands.** The whole
  security model currently rests on "only staff know the link" — every
  table's RLS policy grants full access to the `anon` role (see
  `DATABASE.md`). This was an explicit project requirement (no login
  system, hardcoded anon key), but if the app is ever bookmarked somewhere
  public, shared in a group chat, or indexed, add email/password or magic-
  link auth and scope the RLS policies to `authenticated` users only.
- **The Admin/User password gate (`js/auth/authService.js`) is a UX layer,
  not this missing security layer.** It hides the invoicing/pricing tabs
  from the "User" role on a shared device and nothing more — the two
  passwords are plain strings sitting in the client bundle, and Supabase
  itself doesn't know or care which role is "logged in" (the RLS policies
  above are what actually gate the data, and they're still wide open to
  anyone with the anon key). Don't mistake this gate for real access
  control when deciding whether it's safe to widen who can reach the app's
  URL — that decision should be made on the Supabase Auth item above, not
  on this one.
- **Sharing a PDF with a guest.** Right now the only way to get an invoice
  PDF out of the app is downloading it locally and sending it manually. A
  "share a link with the guest" feature would need a Storage bucket after
  all (with short-lived signed URLs, not a public one) — see the note below
  on why there isn't one today.

## Pricing

- **Per-villa-type pricing.** `neom_price` currently has no villa type
  column — one set of seasonal rates applies to both the 2- and 3-bedroom
  villa, matching the fields the project brief specifies. If the two villas
  ever need different rates, add a `villa_type` column to `neom_price`,
  include it in the exclusion constraint
  (`EXCLUDE USING gist (villa_type WITH =, daterange(...) WITH &&)`, which
  does need the `btree_gist` extension), and filter
  `calculateStayPricing()` by the selected villa type.
- **Bulk pricing entry.** Adding a full year of seasonal rates currently
  means one form submission per range. A "duplicate this rule to next year"
  or CSV import action would speed up annual rate setup.

## Availability

- **Range/bulk status editing.** The calendar currently edits one date at a
  time (a deliberate choice for speed — one click opens the popover, one
  more sets the status). A click-and-drag range select would help when
  blocking out a multi-week maintenance period, at the cost of a slightly
  more complex interaction.
- **Auto-sync from bookings.** Right now availability and invoices are
  independent — creating an invoice doesn't automatically mark those dates
  "Booked." Wiring that up would remove a manual step, at the cost of
  deciding what should happen when an invoice is later edited or a booking
  falls through.

## PDF / invoicing

- **No stored PDF files, by design.** `neom_pdf` holds only a JSON snapshot
  of each revision's data; re-downloading an old revision regenerates the
  PDF from that snapshot rather than fetching a previously-rendered file
  (see `DATABASE.md` → "Why no Storage bucket"). The one thing this gives
  up: if the invoice *layout* changes later, old revisions render in the
  new layout when re-downloaded, not the exact original pixels — only the
  data (guest name, dates, rates, total) is guaranteed to stay faithful. If
  byte-for-byte historical PDFs ever become a requirement (e.g. for a
  dispute with a guest), reintroduce a Storage bucket and upload the
  rendered blob alongside the data snapshot.
- **Arabic text in the PDF is a small embedded image, not vector text.**
  See `PDF_ENGINE.md` → "Arabic text: rendered via canvas, not as PDF vector
  text" for the full story — the vector approach (pre-shaping into
  presentation-form glyphs for jsPDF to draw) produced letters that didn't
  visually connect for several common letter pairs, traced back to how
  jsPDF/the font positions CID glyphs rather than anything fixable in this
  app's shaping code. Rendering via the browser's own canvas text engine
  fixed the visual bug but means that one string isn't selectable or
  search-indexable in the exported PDF, unlike every other word on the
  invoice. If that trade-off ever becomes a real problem (e.g. staff need to
  search invoices by Arabic guest name), the fix is a proper WASM text-
  shaping engine (`harfbuzzjs`) driving real vector glyph paths instead of
  either approach tried so far — a substantially bigger undertaking, only
  worth it if the image trade-off actually bites in practice.
- **Emailing invoices directly.** The app only produces a local download
  today. Sending the generated PDF straight to a guest's email would need a
  server-side function (Supabase Edge Function) since this is a static
  client-only app with no backend to send mail from.

## Offline support

- **There is none, by design.** A cache-first service worker was tried
  early on to cache the app shell for fast repeat loads, but it caused more
  friction than it was worth: every edit to a cached file needed a manual
  cache-version bump to reach already-installed clients, and a normal
  reload (as opposed to a hard reload) kept serving stale files in the
  meantime — confusing during active development on a staff tool that's
  always used online anyway. It was removed; `js/app.js`'s
  `unregisterServiceWorker()` actively cleans up any service worker a
  client installed before that change. If offline support (or the "Add to
  Home Screen" installability Chrome ties to having a service worker) is
  ever genuinely needed, re-add one with a **network-first** (not
  cache-first) strategy so it doesn't reintroduce the same staleness
  problem, and pair it with an offline write queue (e.g. via IndexedDB)
  since Supabase calls always require a live connection regardless.
