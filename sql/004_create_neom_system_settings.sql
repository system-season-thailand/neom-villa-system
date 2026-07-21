-- =============================================================================
-- 004_create_neom_system_settings.sql
-- Neom Villa staff console — small staff-editable option lists (currently
-- just "Guest By"), stored in the database instead of hardcoded so staff can
-- grow the list from the app itself without a code change.
--
-- Run this AFTER 001_create_neom_pdf.sql (reuses its set_updated_at()
-- trigger function). Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: neom_system_settings
-- One row per option. `setting_key` groups related options (currently only
-- 'guest_by' exists, but the table is generic enough to hold future staff-
-- editable lists under a different key without a schema change).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS neom_system_settings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key    text NOT NULL,
  setting_value  text NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT neom_system_settings_unique UNIQUE (setting_key, setting_value)
);

CREATE INDEX IF NOT EXISTS idx_neom_system_settings_key ON neom_system_settings (setting_key);

DROP TRIGGER IF EXISTS trg_neom_system_settings_updated_at ON neom_system_settings;
CREATE TRIGGER trg_neom_system_settings_updated_at
  BEFORE UPDATE ON neom_system_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Seed data: the initial "Guest By" list. ON CONFLICT DO NOTHING makes this
-- safe to re-run — it will never duplicate or reset options staff have
-- already added or that already exist from a prior run.
-- -----------------------------------------------------------------------------
INSERT INTO neom_system_settings (setting_key, setting_value, sort_order)
VALUES
  ('guest_by', 'Tariq', 1),
  ('guest_by', 'Turky', 2),
  ('guest_by', 'Abod', 3),
  ('guest_by', 'Abdullah', 4),
  ('guest_by', 'Wael', 5),
  ('guest_by', 'Nasser', 6),
  ('guest_by', 'M. Kamarani', 7),
  ('guest_by', 'Motaz', 8),
  ('guest_by', 'Ali', 9),
  ('guest_by', 'Jalal', 10),
  ('guest_by', 'Boss Sami', 11),
  ('guest_by', 'Abu Sama', 12),
  ('guest_by', 'Rayan', 13),
  ('guest_by', 'عميل خاص', 14),
  ('guest_by', 'عميل مباشر', 15)
ON CONFLICT (setting_key, setting_value) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Row Level Security — see the note in 001_create_neom_pdf.sql for why this
-- is open to anon/authenticated rather than scoped to an authenticated user.
-- -----------------------------------------------------------------------------
ALTER TABLE neom_system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neom_system_settings_allow_all ON neom_system_settings;
CREATE POLICY neom_system_settings_allow_all ON neom_system_settings
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
