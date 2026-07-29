-- =============================================================================
-- 010_add_on_hold_at.sql
-- Neom Villa staff console — tracks *when* a date was marked On Hold, so the
-- Availability calendar can show a live "time remaining" countdown to its
-- 24-hour auto-revert (see 011_on_hold_auto_revert.sql) and so staff can see
-- how long a date has actually been on hold.
--
-- Run this AFTER 008_add_booked_at.sql — it replaces that file's
-- set_availability_booked_at() trigger with a combined one that handles both
-- booked_at and on_hold_at, rather than keeping two near-identical triggers.
-- Safe to re-run.
-- =============================================================================

ALTER TABLE neom_availability ADD COLUMN IF NOT EXISTS on_hold_at timestamptz;

DROP TRIGGER IF EXISTS trg_neom_availability_booked_at ON neom_availability;
DROP FUNCTION IF EXISTS set_availability_booked_at();

-- -----------------------------------------------------------------------------
-- booked_at / on_hold_at are both derived, not chosen by the client — same
-- pattern as status_color (see 003_create_neom_availability.sql). Each is set
-- to the current time the moment a date's status *becomes* that status (from
-- anything else), left untouched by any later save that keeps the same
-- status (e.g. just editing notes) so it still reflects the original
-- moment, and cleared back to NULL the moment the status moves away —
-- mirroring how booked_by is cleared for every non-booked status.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_availability_status_timestamps()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'booked' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'booked' THEN
      NEW.booked_at := now();
    ELSE
      NEW.booked_at := OLD.booked_at;
    END IF;
  ELSE
    NEW.booked_at := NULL;
  END IF;

  IF NEW.status = 'on_hold' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'on_hold' THEN
      NEW.on_hold_at := now();
    ELSE
      NEW.on_hold_at := OLD.on_hold_at;
    END IF;
  ELSE
    NEW.on_hold_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_neom_availability_status_timestamps ON neom_availability;
CREATE TRIGGER trg_neom_availability_status_timestamps
  BEFORE INSERT OR UPDATE ON neom_availability
  FOR EACH ROW
  EXECUTE FUNCTION set_availability_status_timestamps();
