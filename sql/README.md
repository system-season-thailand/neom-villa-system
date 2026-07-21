# Database setup

Three SQL scripts create everything the app needs: tables, constraints,
indexes, triggers, helper functions, and RLS policies. After running them
the app works immediately — no further database changes are needed.

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
3. Confirm each script reports success before running the next one — 002 and 003 both call a function defined in 001.

Every statement in every script is idempotent (`CREATE ... IF NOT EXISTS`,
`DROP POLICY/TRIGGER IF EXISTS` before recreating), so re-running a script —
or all three — is always safe.

## What gets created

| Table | Purpose |
|---|---|
| `neom_pdf` | One row per saved invoice **revision**, storing a full JSON data snapshot (no PDF file). Never updated or deleted by the app — only ever inserted, so old revisions are never overwritten. |
| `neom_price` | Seasonal nightly rates. A GiST exclusion constraint makes overlapping date ranges impossible to insert. |
| `neom_availability` | One row per calendar date that has ever been changed from its default. Sparse by design — see the comment at the top of `003_create_neom_availability.sql`. |

Helper functions (all called from the app via `supabase.rpc(...)`):

- `generate_invoice_number()` — reserves the next sequential, never-reused invoice number.
- `insert_invoice_revision(...)` — atomically computes the next revision number for an invoice and inserts it, under an advisory lock so two staff saving at once can't collide.

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
