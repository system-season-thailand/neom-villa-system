# Database

Supabase project (Postgres only — no Storage bucket). Schema source of truth
is [`/sql`](sql/) — this document explains the *why* behind it and the
application-level logic layered on top. See [`sql/README.md`](sql/README.md)
for setup instructions.

## Tables

### `neom_pdf` — invoice revisions

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `invoice_number` | text | Shared across every revision of the same invoice, e.g. `INV-2026-0042` |
| `revision_number` | integer | Starts at 1, increments per invoice number |
| `invoice_data` | jsonb | Full snapshot of the form at save time: guest name, dates, nights, villa type, pricing rows, total, and the original PDF generation timestamp |
| `created_at` / `updated_at` | timestamptz | |

No PDF file is stored anywhere — see "Why no Storage bucket" below.

Unique on `(invoice_number, revision_number)`. No foreign keys — `neom_pdf`,
`neom_price`, and `neom_availability` are independent; there's no natural
relationship between an invoice and a specific pricing rule (a stay can span
several), so the invoice stores its own computed pricing snapshot in
`invoice_data` rather than referencing `neom_price` rows.

## Why no Storage bucket

`pdfGenerator.js` builds the invoice PDF entirely from `invoice_data` —
guest name, dates, nights, villa type, pricing rows, total, and the
generation timestamp. Since that same JSON is already saved on every
revision row, regenerating the exact original PDF later is just calling
`generateInvoicePdf()` again with it — there's nothing a stored file would
provide that the data snapshot doesn't already give you, and the app never
needs to hand a guest a URL to a hosted file (or manage a public/signed link
to one). Dropping the bucket means: no `storage.objects` RLS policies to
maintain, no orphaned-file cleanup to think about, and "browsing old
revisions" is one query against one table instead of a table read plus a
file fetch. The trade-off — covered in `FUTURE_IMPROVEMENTS.md` — is that if
the PDF layout code changes in the future, regenerating an old revision
applies the *current* layout to it rather than reproducing pixel-for-pixel
whatever the original rendering looked like; only the data (guest name,
dates, rates, total) is guaranteed to stay faithful to what was originally
generated.

### `neom_price` — seasonal pricing

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `start_date` / `end_date` | date | Inclusive on both ends |
| `price_per_night` | numeric(14,2) | IDR, must be > 0 |
| `season_note` | text | Free text — "High Season", "Ramadan", etc. |

A GiST **exclusion constraint** (`EXCLUDE USING gist (daterange(start_date,
end_date, '[]') WITH &&)`) makes it impossible at the database level to
insert a range that overlaps an existing one — this is the actual mechanism
behind "Prevent overlapping pricing ranges," not just client-side
validation. The app also validates client-side first so staff get an
immediate, friendly message rather than waiting on a round trip to hit the
constraint.

**Design note:** the schema has no `villa_type` column — a pricing rule
applies regardless of whether the stay is booked as the 2- or 3-bedroom
villa. This matches the pricing fields the project brief specifies
(`Start Date`, `End Date`, `Price Per Night`, `Season Note`) exactly. If
villa-type-specific pricing is needed later, see `FUTURE_IMPROVEMENTS.md`.

### `neom_availability` — calendar status

| Column | Type | Notes |
|---|---|---|
| `date` | date, PK | One row per date that has ever been set |
| `status` | text | `available` \| `booked` \| `on_hold` \| `blocked` — **not** `passed` (see below) |
| `status_color` | text | Hex color, set automatically by a trigger from `status` — never chosen by the client |
| `notes` | text | Optional |

**This table is sparse by design.** It is not pre-populated with every
calendar date. A date with no row is treated by the app as:

- **Passed**, if the date is before today
- **Available**, if the date is today or in the future

This is why `status` cannot be set to `'passed'` — the check constraint only
allows the four staff-settable values. "Passed" is a pure function of
`date < CURRENT_DATE`, computed by the app (see `getStatusesInRange()` in
`js/services/availabilityService.js`) every time the calendar is rendered,
which is also why it requires no cron job, scheduled function, or nightly
batch update: it's correct by construction, at any moment, with zero
maintenance.

## Revision system

Every PDF download creates a **new row**, never an update:

1. The client asks Postgres for a read-only preview of the next revision
   number (`peekNextRevisionNumber`, a plain `SELECT ... ORDER BY
   revision_number DESC LIMIT 1`), purely so the PDF can print "Revision N"
   before it's saved.
2. `pdfGenerator.js` renders the PDF blob entirely client-side, in memory.
3. `insert_invoice_revision(...)` — a Postgres function — is called via RPC
   with the invoice number and the `invoice_data` snapshot (no file
   involved). It takes an **advisory lock keyed on the invoice number**
   (`pg_advisory_xact_lock(hashtextextended(invoice_number, 0))`), then
   computes `MAX(revision_number) + 1` and inserts the row, inside one
   transaction. The advisory lock is what makes this safe even if two staff
   happened to save the same invoice number at the exact same moment — the
   read-then-insert can't race.

The app never issues an `UPDATE` or `DELETE` against `neom_pdf`. "Editing an
invoice" means loading a past revision's `invoice_data` back into the form
(Invoice tab → Revisions panel, or the Import Invoice modal) and downloading
again, which — per the above — always produces a brand-new row.

## Pricing calculation (multi-season splitting)

Given a check-in date and a night count, `calculateStayPricing()` in
`js/services/invoiceService.js`:

1. Fetches every `neom_price` row whose range overlaps the stay.
2. Walks the stay night by night, looking up which rule (if any) covers
   each night. Because pricing ranges can never overlap (enforced by the
   exclusion constraint), at most one rule matches each night.
3. If any night has no matching rule, the whole calculation returns which
   dates are missing — the app surfaces this directly and blocks PDF
   generation rather than defaulting to zero or guessing a rate.
4. Otherwise, consecutive nights under the *same* pricing rule are grouped
   into a single invoice line (matching the project brief's example: 3
   nights at one rate + 2 nights at another = two rows, not five).

## Row Level Security

This is a staff-only tool with no login screen — the brief explicitly calls
for the Supabase anon key to be hardcoded client-side rather than gated
behind environment variables or a build step. RLS is **enabled on every
table** for defense-in-depth, but since there's no per-user auth to scope
policies to, each table has one permissive policy granting full access to
the `anon`/`authenticated` roles — i.e., "authorize anyone who has the anon
key," which in this app's context means "anyone who can load the page." If
the app's URL is ever exposed outside trusted staff, add Supabase Auth and
narrow these policies — see `FUTURE_IMPROVEMENTS.md`.
