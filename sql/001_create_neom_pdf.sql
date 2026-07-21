-- =============================================================================
-- 001_create_neom_pdf.sql
-- Neom Villa staff console — invoice/PDF revision table and the shared
-- helper functions/trigger used across all three tables.
--
-- Run this FIRST — 002 and 003 depend on the set_updated_at() trigger
-- function defined here. Safe to re-run (every statement is idempotent).
-- =============================================================================

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
--
-- The sequence is only ever advanced (nextval) from inside
-- insert_invoice_revision() below, at the moment a brand-new invoice is
-- actually saved — never just by loading the Invoice tab or generating a
-- preview. Numbers used to be minted on every page load/mount, which burned
-- one every time staff refreshed the page or imported an old invoice without
-- ever downloading a new one, leaving permanent gaps. peek_next_invoice_number()
-- lets the UI show what the next number *would* be without consuming it.
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS neom_invoice_number_seq START WITH 1 INCREMENT BY 1;

DROP FUNCTION IF EXISTS generate_invoice_number();

CREATE OR REPLACE FUNCTION peek_next_invoice_number()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
    lpad((last_value + CASE WHEN is_called THEN 1 ELSE 0 END)::text, 4, '0')
  FROM neom_invoice_number_seq;
$$;

-- -----------------------------------------------------------------------------
-- Atomic revision insert: computes the next revision_number for an invoice
-- number and inserts the row in one statement, under an advisory lock keyed
-- on the invoice number, so two staff saving the same invoice at the same
-- moment can never collide on the same revision number.
--
-- p_invoice_number is nullable: pass NULL for a brand-new invoice that has
-- never been saved before, and this function mints the real number itself
-- (nextval) as part of the same insert — the number is only ever consumed at
-- the moment it's actually used. Pass the existing invoice_number when
-- adding a revision to an invoice that's already been saved at least once.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_invoice_revision(
  p_invoice_number text,
  p_invoice_data jsonb
)
RETURNS neom_pdf
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_number text;
  v_next_revision integer;
  v_row neom_pdf;
BEGIN
  IF p_invoice_number IS NULL THEN
    v_invoice_number := 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
      lpad(nextval('neom_invoice_number_seq')::text, 4, '0');
    v_next_revision := 1;
  ELSE
    v_invoice_number := p_invoice_number;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_invoice_number, 0));

    SELECT COALESCE(MAX(revision_number), 0) + 1
    INTO v_next_revision
    FROM neom_pdf
    WHERE invoice_number = v_invoice_number;
  END IF;

  INSERT INTO neom_pdf (invoice_number, revision_number, invoice_data)
  VALUES (v_invoice_number, v_next_revision, p_invoice_data)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- peek_next_invoice_number() reads the sequence directly (SELECT ... FROM
-- neom_invoice_number_seq) rather than calling nextval(), so it needs its
-- own explicit SELECT grant — nextval() below only needs USAGE, which
-- Supabase's default privileges already cover for anon/authenticated.
GRANT SELECT ON neom_invoice_number_seq TO anon, authenticated;
GRANT EXECUTE ON FUNCTION peek_next_invoice_number() TO anon, authenticated;
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
