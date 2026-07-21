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
- **Full Unicode BiDi.** `arabicReshaper.js` implements shaping plus a
  simplified, first-strong-character BiDi reorder — correct for the
  realistic cases here (a pure-Arabic or pure-Latin guest name, or a short
  mix), but not a complete UAX #9 implementation. A guest name with several
  alternating Arabic/Latin words could reorder imperfectly. Pulling in a
  proper BiDi library would only be worth the added weight if that pattern
  actually shows up in practice.
- **Emailing invoices directly.** The app only produces a local download
  today. Sending the generated PDF straight to a guest's email would need a
  server-side function (Supabase Edge Function) since this is a static
  client-only app with no backend to send mail from.

## Offline support

- The service worker caches the app shell and CDN libraries for fast
  repeat loads, but Supabase calls always require a live connection — there
  is no offline write queue. A staff member creating an invoice mid-flight
  with no signal would need to retry once back online. Adding an offline
  queue (e.g. via IndexedDB) would be a meaningful chunk of work relative
  to how often that scenario actually occurs for a single-property villa
  business.
