# Supabase Table Creation — Neom Villa Staff Console

This file contains the complete SQL needed to create the three Supabase
tables this app uses (`neom_pdf`, `neom_price`, `neom_availability`), plus
their indexes, constraints, triggers, helper functions, and RLS policies.
After running these, the app works immediately with no further database
changes required.

There is no Storage bucket. Every invoice revision stores a full JSON
snapshot of its data in `neom_pdf.invoice_data`; the PDF itself is
regenerated client-side on demand from that snapshot (see
[`PDF_ENGINE.md`](../PDF_ENGINE.md)) rather than uploaded and kept as a file.

The same SQL also lives as three standalone, individually-runnable files in
[`/sql`](../sql/) at the project root — use those if you prefer running one
file at a time in the Supabase SQL Editor. This document exists as a single
reference copy, per the source-of-truth file this project's build prompt
asked for.

## How to run

Open your Supabase project → **SQL Editor**, and run the three sections
below **in order** (Part 2 and Part 3 both call a function defined in
Part 1). Every statement is idempotent, so re-running any part is safe.

---

## Part 1 — `neom_pdf` (run first)

Creates the invoice/PDF revisions table, sequential invoice numbering, the
atomic revision-insert function, and the shared `set_updated_at()` trigger
function (reused by Parts 2 and 3).

```sql
-- gen_random_uuid() ships in Postgres core since v13, but Supabase projects
-- created from very old templates may still need pgcrypto — this is a no-op
-- if it's already available.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Shared trigger function: keeps `updated_at` current on every UPDATE.
-- Reused by neom_price and neom_availability as well.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Table: neom_pdf
-- One row per saved invoice REVISION. `invoice_number` is shared across every
-- revision of the same invoice; `revision_number` increments per invoice
-- number. Rows are immutable in practice — the app never updates or deletes
-- them, it only inserts new revisions — so old invoices are never overwritten.
--
-- No PDF file is stored anywhere. `invoice_data` is a complete snapshot
-- (guest name, dates, nights, villa type, pricing rows, total, and the
-- original generation timestamp) — everything the app needs to regenerate
-- the exact same PDF on demand client-side. This keeps the whole system to
-- a single Postgres table with no Storage bucket to manage.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS neom_pdf (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number   text NOT NULL,
  revision_number  integer NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  invoice_data     jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT neom_pdf_invoice_revision_unique UNIQUE (invoice_number, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_neom_pdf_invoice_number ON neom_pdf (invoice_number);
CREATE INDEX IF NOT EXISTS idx_neom_pdf_created_at ON neom_pdf (created_at DESC);
-- Powers the "Import Invoice" guest-name search (invoice_data->>'guestName').
CREATE INDEX IF NOT EXISTS idx_neom_pdf_guest_name ON neom_pdf ((invoice_data ->> 'guestName'));

DROP TRIGGER IF EXISTS trg_neom_pdf_updated_at ON neom_pdf;
CREATE TRIGGER trg_neom_pdf_updated_at
  BEFORE UPDATE ON neom_pdf
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Invoice numbering: a single monotonically increasing sequence, formatted
-- as INV-<year>-<4-digit sequence>. The sequence never resets, so numbers
-- are guaranteed sequential and never duplicated even across years.
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS neom_invoice_number_seq START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_seq bigint;
BEGIN
  v_seq := nextval('neom_invoice_number_seq');
  RETURN 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(v_seq::text, 4, '0');
END;
$$;

-- -----------------------------------------------------------------------------
-- Atomic revision insert: computes the next revision_number for an invoice
-- number and inserts the row in one statement, under an advisory lock keyed
-- on the invoice number, so two staff saving the same invoice at the same
-- moment can never collide on the same revision number.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_invoice_revision(
  p_invoice_number text,
  p_invoice_data jsonb
)
RETURNS neom_pdf
LANGUAGE plpgsql
AS $$
DECLARE
  v_next_revision integer;
  v_row neom_pdf;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_invoice_number, 0));

  SELECT COALESCE(MAX(revision_number), 0) + 1
  INTO v_next_revision
  FROM neom_pdf
  WHERE invoice_number = p_invoice_number;

  INSERT INTO neom_pdf (invoice_number, revision_number, invoice_data)
  VALUES (p_invoice_number, v_next_revision, p_invoice_data)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION generate_invoice_number() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION insert_invoice_revision(text, jsonb) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- This is a staff-only tool with no login system (see PWA-BUILDING_PROMPT.md)
-- and ships its Supabase anon key hardcoded in the client. RLS is enabled on
-- every table for defense-in-depth, but since there is no auth layer to key
-- policies off of, access is granted broadly to the anon/authenticated roles.
-- If this app's URL is ever exposed beyond trusted staff, add Supabase Auth
-- and tighten these policies accordingly (see FUTURE_IMPROVEMENTS.md).
-- -----------------------------------------------------------------------------
ALTER TABLE neom_pdf ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neom_pdf_allow_all ON neom_pdf;
CREATE POLICY neom_pdf_allow_all ON neom_pdf
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
```

---

## Part 2 — `neom_price` (run second)

Seasonal pricing rules. A GiST exclusion constraint makes it impossible to
insert a date range that overlaps an existing one.

```sql
-- -----------------------------------------------------------------------------
-- Table: neom_price
-- Each row is a date range with a nightly rate. Ranges may span any number
-- of years and must never overlap another range (enforced below), so any
-- given calendar date maps to at most one price.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS neom_price (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  price_per_night  numeric(14,2) NOT NULL CHECK (price_per_night > 0),
  season_note      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT neom_price_date_order CHECK (end_date >= start_date),
  -- Prevents overlapping pricing ranges at the database level — the '[]'
  -- bound makes both start_date and end_date inclusive, matching how the
  -- app treats a night as belonging to whichever rule's [start,end] it falls in.
  CONSTRAINT neom_price_no_overlap EXCLUDE USING gist (
    daterange(start_date, end_date, '[]') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_neom_price_start_date ON neom_price (start_date);
CREATE INDEX IF NOT EXISTS idx_neom_price_season_note ON neom_price (season_note);

DROP TRIGGER IF EXISTS trg_neom_price_updated_at ON neom_price;
CREATE TRIGGER trg_neom_price_updated_at
  BEFORE UPDATE ON neom_price
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security — see the note in Part 1 for why this is open to
-- anon/authenticated rather than scoped to an authenticated user.
-- -----------------------------------------------------------------------------
ALTER TABLE neom_price ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neom_price_allow_all ON neom_price;
CREATE POLICY neom_price_allow_all ON neom_price
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
```

---

## Part 3 — `neom_availability` (run third)

Calendar availability. This table is intentionally sparse — a date with no
row is treated by the app as "Available" (future) or "Passed" (past); staff
only ever write a row when a date's status actually changes. "Passed" is
never stored: it's derived purely from the date being before today, which is
also why it's excluded from the status check constraint below (staff cannot
set a date to "Passed" manually — it's fully automatic).

```sql
CREATE TABLE IF NOT EXISTS neom_availability (
  date         date PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('available', 'booked', 'on_hold', 'blocked')),
  status_color text NOT NULL,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_neom_availability_status ON neom_availability (status);

-- -----------------------------------------------------------------------------
-- status_color is derived from status, not chosen freely by the client, so
-- the two can never drift out of sync. Colors match the legend used across
-- the app (see css/base.css / js/services/availabilityService.js).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_availability_color()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.status_color := CASE NEW.status
    WHEN 'available' THEN '#1a7f5a'
    WHEN 'booked'    THEN '#c1402c'
    WHEN 'on_hold'   THEN '#7c5cbf'
    WHEN 'blocked'   THEN '#454b56'
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_neom_availability_color ON neom_availability;
CREATE TRIGGER trg_neom_availability_color
  BEFORE INSERT OR UPDATE OF status ON neom_availability
  FOR EACH ROW
  EXECUTE FUNCTION set_availability_color();

DROP TRIGGER IF EXISTS trg_neom_availability_updated_at ON neom_availability;
CREATE TRIGGER trg_neom_availability_updated_at
  BEFORE UPDATE ON neom_availability
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security — see the note in Part 1 for why this is open to
-- anon/authenticated rather than scoped to an authenticated user.
-- -----------------------------------------------------------------------------
ALTER TABLE neom_availability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neom_availability_allow_all ON neom_availability;
CREATE POLICY neom_availability_allow_all ON neom_availability
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
```

---

## What gets created

| Table | Purpose |
|---|---|
| `neom_pdf` | One row per saved invoice **revision**, storing a full JSON data snapshot (no PDF file). Never updated or deleted by the app — only ever inserted, so old revisions are never overwritten. |
| `neom_price` | Seasonal nightly rates. A GiST exclusion constraint makes overlapping date ranges impossible to insert. |
| `neom_availability` | One row per calendar date that has ever been changed from its default. Sparse by design. |

Helper functions (called from the app via `supabase.rpc(...)`):

- `generate_invoice_number()` — reserves the next sequential, never-reused invoice number.
- `insert_invoice_revision(...)` — atomically computes the next revision number for an invoice and inserts it, under an advisory lock so two staff saving at once can't collide.

## Security model

This is a staff-only tool with no login screen, and it ships its Supabase
**anon key** hardcoded in the client (by design). Row Level Security is
enabled on every table for defense-in-depth, but since there's no auth layer
to scope policies to a specific user, the policies grant full access to the
`anon`/`authenticated` roles. If this app's URL is ever shared outside
trusted staff, add Supabase Auth and tighten these policies — see
`FUTURE_IMPROVEMENTS.md`.

There is no Storage bucket, so there's no PDF file access to secure —
invoices exist only as `invoice_data` JSON inside `neom_pdf`, protected by
the same RLS policy as the rest of the table.
