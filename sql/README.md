# Database setup

Eleven numbered SQL scripts create everything the app needs: tables,
constraints, indexes, triggers, helper functions, RLS policies, Realtime,
and a scheduled job. After running them the app works immediately — no
further database changes are needed. A twelfth file,
[`reset_invoice_numbering.sql`](reset_invoice_numbering.sql), is a separate,
optional, **destructive** script — see its own section below — not part of
this numbered setup sequence.

There is no Storage bucket. Every invoice revision stores a full JSON
snapshot of its data in `neom_pdf.invoice_data`; the PDF itself is
regenerated client-side on demand from that snapshot (see
[`../PDF_ENGINE.md`](../PDF_ENGINE.md)) rather than uploaded and kept as a
file.

## How to run

1. Open your Supabase project → **SQL Editor**.
2. Run each file **in this exact order**, as a new query, top to bottom:
   1. [`001_create_neom_pdf.sql`](001_create_neom_pdf.sql) — invoice/PDF revisions table, invoice numbering, and the shared `set_updated_at()` trigger function that 002/003 depend on.
   2. [`002_create_neom_price.sql`](002_create_neom_price.sql) — seasonal pricing table, with a database-level exclusion constraint that rejects overlapping date ranges.
   3. [`003_create_neom_availability.sql`](003_create_neom_availability.sql) — calendar availability table.
   4. [`004_create_neom_system_settings.sql`](004_create_neom_system_settings.sql) — staff-editable option lists (currently just "Guest By"), seeded with its initial values.
   5. [`005_create_neom_linked_stays.sql`](005_create_neom_linked_stays.sql) — "must be booked together" date groups for the Availability calendar.
   6. [`006_add_booked_by.sql`](006_add_booked_by.sql) — adds a "Booked By" column to `neom_availability` and seeds its dropdown's initial values, powering the "ملخص" (Summary) tab.
   7. [`007_enable_availability_realtime.sql`](007_enable_availability_realtime.sql) — turns on Supabase Realtime for `neom_availability`, so a status change on one device shows up live on every other device with the Availability calendar open.
   8. [`008_add_booked_at.sql`](008_add_booked_at.sql) — adds a `booked_at` column to `neom_availability`, auto-set by a trigger to the moment a date's status becomes `'booked'`, powering the "Booked on …" note shown in the Availability calendar's status popover.
   9. [`009_stop_storing_available.sql`](009_stop_storing_available.sql) — stops `'available'` from ever being written to `neom_availability` (most dates are Available, so recording a row for every one defeats the whole point of the table being sparse); deletes any existing `'available'` rows and tightens the status check constraint to `'booked' | 'on_hold' | 'blocked'` only.
   10. [`010_add_on_hold_at.sql`](010_add_on_hold_at.sql) — adds an `on_hold_at` column to `neom_availability`, auto-set by a trigger to the moment a date's status becomes `'on_hold'`; replaces 008's single-purpose trigger with one that handles both `booked_at` and `on_hold_at`.
   11. [`011_on_hold_auto_revert.sql`](011_on_hold_auto_revert.sql) — schedules a `pg_cron` job that reverts any date on hold for 24+ hours back to Available (by deleting its row), so it happens automatically whether or not anyone has the app open. Requires the `pg_cron` extension.
3. Confirm each script reports success before running the next one — every script from 002 on calls a function or depends on a table/column defined earlier.

Every statement in every script is idempotent (`CREATE ... IF NOT EXISTS`,
`DROP POLICY/TRIGGER IF EXISTS` before recreating), so re-running a script —
or all three — is always safe.

## What gets created

| Table | Purpose |
|---|---|
| `neom_pdf` | One row per saved invoice **revision**, storing a full JSON data snapshot (no PDF file). Never updated or deleted by the app — only ever inserted, so old revisions are never overwritten. |
| `neom_price` | Seasonal nightly rates. A GiST exclusion constraint makes overlapping date ranges impossible to insert. |
| `neom_availability` | One row per calendar date currently `'booked'`, `'on_hold'`, or `'blocked'` — Available and Passed are never stored, both are pure read-time defaults. Sparse by design — see the comment at the top of `003_create_neom_availability.sql` and `009_stop_storing_available.sql`. |
| `neom_system_settings` | Staff-editable option lists, one row per option. Powers the Invoice tab's "Guest By" dropdown (`setting_key = 'guest_by'`) and the Availability tab's "Booked By" dropdown (`setting_key = 'booked_by'`) — both editable (add/rename/delete) from their own dropdown. The `setting_key` column exists to hold further lists too, without a schema change. |
| `neom_linked_stays` | Date ranges staff have marked as one indivisible stay (e.g. "Dec 29–31 must be booked together"). A GiST exclusion constraint makes overlapping ranges impossible to insert, same as `neom_price`. Purely an informational marker on the calendar — see `DATABASE.md`. |

`006_add_booked_by.sql` also adds a `booked_by` column directly to
`neom_availability` (who made a booking, only ever set when `status =
'booked'`) — see `DATABASE.md`, which feeds the Summary tab's per-booker
revenue breakdown.

`007_enable_availability_realtime.sql` adds `neom_availability` to the
`supabase_realtime` publication. Without it the Availability tab still works
exactly the same on a single device — it just won't pick up changes made on
*another* device until the calendar is next reloaded or navigated.

`008_add_booked_at.sql` adds a `booked_at` timestamptz column to
`neom_availability`, set by a trigger the moment a date's status transitions
*to* `'booked'` (and cleared back to `NULL` the moment it moves away from
`'booked'`) — see `DATABASE.md`.

`009_stop_storing_available.sql` makes `'available'` behave exactly like
`'passed'` already does: a pure read-time default for a date with no row,
never written directly. The app deletes a date's row (see `clearStatus()` /
`setStatus()` in `js/services/availabilityService.js`) instead of writing
`status = 'available'` to it.

`010_add_on_hold_at.sql` adds an `on_hold_at` timestamptz column, the same
pattern as `booked_at` above but for `'on_hold'` — see `DATABASE.md`.

`011_on_hold_auto_revert.sql` schedules a `pg_cron` job (every 5 minutes)
that deletes any `neom_availability` row where `status = 'on_hold'` and
`on_hold_at` is 24+ hours old, so it reverts to Available with nobody
needing to have the app open. The app *also* treats an On Hold date as
expired client-side the instant anyone actually looks at it (see
`isExpiredOnHold()` in `availabilityService.js`) rather than waiting on the
next cron tick — the cron job is the real, always-on backstop; the
client-side check just avoids up to a 5-minute display lag for whoever's
actually watching.

Helper functions (all called from the app via `supabase.rpc(...)`):

- `peek_next_invoice_number()` — read-only preview of what the next invoice number *would* be, without consuming it. Numbers are only actually minted by `insert_invoice_revision()` below, at the moment a brand-new invoice is first saved.
- `insert_invoice_revision(...)` — atomically computes the next revision number for an invoice and inserts it, under an advisory lock so two staff saving at once can't collide. Pass a `NULL` invoice number for a brand-new invoice and it mints the real, permanent number itself as part of the same insert.

## Resetting invoice numbering (optional, destructive)

[`reset_invoice_numbering.sql`](reset_invoice_numbering.sql) permanently
deletes every row in `neom_pdf` and restarts invoice numbering so the next
invoice saved is `INV-<year>-0125`. This is **not** part of the numbered
setup above — it's a standalone script you run only when you actually want
to wipe every saved invoice and start renumbering from a specific point.
There is no undo; export the table first if there's any chance you'll want
that data again.

## Security model

This is a staff-only tool with no login screen, and it ships its Supabase
**anon key** hardcoded in the client (by design — see
`PWA-BUILDING_PROMPT.md`). Row Level Security is enabled on every table for
defense-in-depth, but since there's no auth layer to scope policies to a
specific user, the policies grant full access to the `anon`/`authenticated`
roles. If this app's URL is ever shared outside trusted staff, add Supabase
Auth and tighten these policies — see `FUTURE_IMPROVEMENTS.md`.

There is no Storage bucket, so there's no PDF file access to secure —
invoices exist only as `invoice_data` JSON inside `neom_pdf`, protected by
the same RLS policy as the rest of the table.
