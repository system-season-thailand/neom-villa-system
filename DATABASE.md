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

### `neom_system_settings` — staff-editable option lists

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `setting_key` | text | Groups related options — currently only `'guest_by'` exists |
| `setting_value` | text | The option's display text, e.g. `'Tariq'` |
| `sort_order` | integer | Seed data is numbered 1–15 in the order given in the project brief; options added later from the app get `999`, so they sort after the original list |

Unique on `(setting_key, setting_value)` so the same name can't be added
twice under one key. This currently powers the Invoice tab's **Guest By**
dropdown (`js/services/settingsService.js`) — staff can add new names
directly from the "+ Add new…" option in that dropdown rather than needing a
code change. The generic `setting_key` column exists so a future
staff-editable list (of a different kind) can reuse this same table instead
of needing a new one.

### `neom_linked_stays` — "must be booked together" date groups

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `start_date` / `end_date` | date | Inclusive on both ends, same convention as `neom_price` |
| `note` | text | Optional — e.g. `"Min 3 nights — New Year's package"` |

Same GiST exclusion constraint as `neom_price` (`EXCLUDE USING gist
(daterange(start_date, end_date, '[]') WITH &&)`), so one date can never
belong to two linked-stay groups at once.

**This is an informational marker, not an enforced booking rule.** The app
has no guest-facing booking flow to actually block a partial booking against
— staff still set each date's `neom_availability` status independently, one
date at a time or via bulk-select. What this table drives is purely the
Availability calendar's own display: any date inside a linked-stay range
renders with a violet ring, a 🔗 badge, and a tooltip/popover explaining the
range and its note (see `findLinkedStayForDate()` in
`js/components/availabilityTab.js`), so staff assigning dates manually can
see at a glance that (for example) Dec 29–31 shouldn't be split up. Both
Admin and User roles see the marker; only Admin can create one (via the
Availability tab's "Select Multiple" bulk bar → **🔗 Link Nights**, which
requires the current selection to be a contiguous run of dates) or remove
one (via the "Unlink" button that appears in a linked date's status
popover).

## Revision system

Every PDF download creates a **new row**, never an update. There is no
"New Invoice" button — the Invoice tab always shows either a brand-new,
not-yet-saved form or an existing invoice loaded for editing, and the only
way to reach a fresh blank form is by actually downloading the current one
(see `handleDownload()` in `js/components/invoiceTab.js`).

1. On mount (or right after a brand-new invoice is downloaded), the client
   asks Postgres for a read-only **preview** of the next invoice number
   (`peekNextInvoiceNumber()` → `peek_next_invoice_number()`, which reads the
   sequence's current state without calling `nextval()`). This number is
   shown in the UI but is not yet real — nothing has consumed it.
2. `pdfGenerator.js` renders the PDF blob entirely client-side, in memory.
3. `insert_invoice_revision(...)` — a Postgres function — is called via RPC
   with the `invoice_data` snapshot and either the existing invoice number
   (revising an already-saved invoice) or `NULL` (a brand-new invoice that's
   never been saved). For `NULL`, the function itself calls `nextval()` on
   the sequence and uses that as both the real invoice number and revision
   1 — **this is the only place a number is ever actually consumed**, which
   is what makes reloading the page, or importing an old invoice to look at
   it, completely free: neither one calls `insert_invoice_revision`, so
   neither one can burn a number. For an existing invoice number, the
   function takes an **advisory lock keyed on the invoice number**
   (`pg_advisory_xact_lock(hashtextextended(invoice_number, 0))`), then
   computes `MAX(revision_number) + 1` and inserts the row, inside one
   transaction. The advisory lock is what makes this safe even if two staff
   happened to save the same invoice number at the exact same moment — the
   read-then-insert can't race.
4. The PDF is generated from the row `insert_invoice_revision` actually
   returned (real invoice number, real revision number) — not from the
   pre-save preview — so the downloaded file and the saved database row can
   never disagree.

**Earlier design, and why it changed:** invoice numbers used to be minted
(via `nextval()`) the moment the Invoice tab mounted, on every page load.
That guaranteed uniqueness just as well, but it meant every page refresh,
or every time staff imported an old invoice just to look at it, silently
burned a number that was never used — permanent gaps with no invoice behind
them. Moving the `nextval()` call inside `insert_invoice_revision()`, gated
behind an actual save, fixes that at the source rather than working around
it client-side.

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
