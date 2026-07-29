-- =============================================================================
-- 009_stop_storing_available.sql
-- Neom Villa staff console — stops 'available' from ever being written to
-- neom_availability. Most dates are Available, so recording a row for every
-- one of them defeats the whole point of the table being sparse by design
-- (see 003_create_neom_availability.sql) — 'available' now works exactly
-- like 'passed' already does: a pure read-time default for any date with no
-- row, never stored directly. The app (availabilityService.js) already
-- deletes a date's row instead of writing status = 'available' to it.
--
-- Run this AFTER 003_create_neom_availability.sql. Safe to re-run.
-- =============================================================================

-- Clears out any rows the app wrote as 'available' before this change — with
-- 'available' now meaning "no row", these are redundant, and would
-- otherwise permanently violate the tightened constraint below.
DELETE FROM neom_availability WHERE status = 'available';

ALTER TABLE neom_availability DROP CONSTRAINT IF EXISTS neom_availability_status_check;
ALTER TABLE neom_availability ADD CONSTRAINT neom_availability_status_check
  CHECK (status IN ('booked', 'on_hold', 'blocked'));

-- 'available' dropped from the CASE below since it can no longer be
-- inserted; on_hold corrected to match the orange actually used client-side
-- (js/services/availabilityService.js's STATUSES map) — this trigger's
-- output was never actually read by the frontend (status is colored via
-- plain CSS, not this column) so the mismatch was harmless, but there's no
-- reason to leave it wrong while touching this function anyway.
CREATE OR REPLACE FUNCTION set_availability_color()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.status_color := CASE NEW.status
    WHEN 'booked'    THEN '#c1402c'
    WHEN 'on_hold'   THEN '#d9730d'
    WHEN 'blocked'   THEN '#454b56'
  END;
  RETURN NEW;
END;
$$;
