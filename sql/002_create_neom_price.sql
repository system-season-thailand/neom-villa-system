-- =============================================================================
-- 002_create_neom_price.sql
-- Neom Villa staff console — seasonal pricing table.
--
-- Run this AFTER 001_create_neom_pdf.sql (reuses its set_updated_at() trigger
-- function). Safe to re-run.
-- =============================================================================

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
-- Row Level Security — see the note in 001_create_neom_pdf.sql for why this
-- is open to anon/authenticated rather than scoped to an authenticated user.
-- -----------------------------------------------------------------------------
ALTER TABLE neom_price ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neom_price_allow_all ON neom_price;
CREATE POLICY neom_price_allow_all ON neom_price
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
