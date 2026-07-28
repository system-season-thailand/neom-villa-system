-- =============================================================================
-- 008_add_booked_at.sql
-- Neom Villa staff console — tracks *when* a date was marked Booked, so the
-- Availability calendar's status popover can show "Booked on <date>" next to
-- the Booked option, not just who booked it.
--
-- Run this AFTER 003_create_neom_availability.sql. Safe to re-run.
-- =============================================================================

ALTER TABLE neom_availability ADD COLUMN IF NOT EXISTS booked_at timestamptz;

-- -----------------------------------------------------------------------------
-- booked_at is derived, not chosen by the client — same pattern as
-- status_color (see 003_create_neom_availability.sql). It's set to the
-- current time the moment a date's status *becomes* 'booked' (from anything
-- else), left untouched by any later save that keeps the status as 'booked'
-- (e.g. just editing notes) so it still reflects the original booking
-- moment, and cleared back to NULL the moment the status moves away from
-- 'booked' — mirroring how booked_by is cleared for every non-booked status.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_availability_booked_at()
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_neom_availability_booked_at ON neom_availability;
CREATE TRIGGER trg_neom_availability_booked_at
  BEFORE INSERT OR UPDATE ON neom_availability
  FOR EACH ROW
  EXECUTE FUNCTION set_availability_booked_at();
