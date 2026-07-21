-- =============================================================================
-- 003_create_neom_availability.sql
-- Neom Villa staff console — calendar availability table.
--
-- Run this AFTER 001_create_neom_pdf.sql (reuses its set_updated_at() trigger
-- function). Safe to re-run.
--
-- Design note: this table is intentionally sparse. A date with no row is
-- treated by the app as "Available" (if in the future) or "Passed" (if in
-- the past) — staff only ever write a row when a date's status actually
-- changes, so the table never needs to be pre-populated with every calendar
-- date. "Passed" itself is never stored: it's a read-time consequence of the
-- date being before today, which is exactly why it's excluded from the
-- status check constraint below and cannot be set by staff.
-- =============================================================================

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
-- Row Level Security — see the note in 001_create_neom_pdf.sql for why this
-- is open to anon/authenticated rather than scoped to an authenticated user.
-- -----------------------------------------------------------------------------
ALTER TABLE neom_availability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neom_availability_allow_all ON neom_availability;
CREATE POLICY neom_availability_allow_all ON neom_availability
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
