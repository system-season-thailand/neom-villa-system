-- =============================================================================
-- 005_create_neom_linked_stays.sql
-- Neom Villa staff console — "must be booked together" date groups.
--
-- Run this AFTER 001_create_neom_pdf.sql (reuses its set_updated_at() trigger
-- function). Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: neom_linked_stays
-- Each row is a contiguous date range that staff have marked as one
-- indivisible stay — e.g. "Dec 29–31 must be booked together, not just any
-- one or two of those nights." Ranges may never overlap (enforced below), so
-- any given calendar date belongs to at most one linked-stay group. This is
-- purely an informational/visual marker for staff — see DATABASE.md — there
-- is no guest-facing booking flow in this app for it to actually block.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS neom_linked_stays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT neom_linked_stays_date_order CHECK (end_date >= start_date),
  -- Prevents overlapping linked-stay ranges at the database level, same
  -- pattern as neom_price — the '[]' bound makes both ends inclusive.
  CONSTRAINT neom_linked_stays_no_overlap EXCLUDE USING gist (
    daterange(start_date, end_date, '[]') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_neom_linked_stays_start_date ON neom_linked_stays (start_date);

DROP TRIGGER IF EXISTS trg_neom_linked_stays_updated_at ON neom_linked_stays;
CREATE TRIGGER trg_neom_linked_stays_updated_at
  BEFORE UPDATE ON neom_linked_stays
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security — see the note in 001_create_neom_pdf.sql for why this
-- is open to anon/authenticated rather than scoped to an authenticated user.
-- -----------------------------------------------------------------------------
ALTER TABLE neom_linked_stays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neom_linked_stays_allow_all ON neom_linked_stays;
CREATE POLICY neom_linked_stays_allow_all ON neom_linked_stays
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
