-- =============================================================================
-- 006_add_booked_by.sql
-- Neom Villa staff console — a "Booked By" dropdown for the Availability
-- calendar, tracking who made each booking (separately from the Invoice
-- tab's "Guest By"). Powers the "ملخص" (Summary) tab's per-booker breakdown.
--
-- Run this AFTER 003_create_neom_availability.sql and
-- 004_create_neom_system_settings.sql. Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- neom_availability gains one column: who booked this date, if it's booked.
-- Free text (like `notes`), not a foreign key — same reasoning as Guest By:
-- the option list is just a staff-editable convenience, not a hard reference,
-- so renaming/deleting an option later never breaks a date that already used
-- the old text.
-- -----------------------------------------------------------------------------
ALTER TABLE neom_availability ADD COLUMN IF NOT EXISTS booked_by text;

-- -----------------------------------------------------------------------------
-- Seed data: a quick pre-fill using the same starting names as "Guest By"
-- (setting_key = 'booked_by' here, stored separately so the two lists can be
-- edited independently from here on). ON CONFLICT DO NOTHING makes this safe
-- to re-run.
-- -----------------------------------------------------------------------------
INSERT INTO neom_system_settings (setting_key, setting_value, sort_order)
VALUES
  ('booked_by', 'Tariq', 1),
  ('booked_by', 'Turky', 2),
  ('booked_by', 'Abod', 3),
  ('booked_by', 'Abdullah', 4),
  ('booked_by', 'Wael', 5),
  ('booked_by', 'Nasser', 6),
  ('booked_by', 'M. Kamarani', 7),
  ('booked_by', 'Motaz', 8),
  ('booked_by', 'Ali', 9),
  ('booked_by', 'Jalal', 10),
  ('booked_by', 'Boss Sami', 11),
  ('booked_by', 'Abu Sama', 12),
  ('booked_by', 'Rayan', 13),
  ('booked_by', 'عميل خاص', 14),
  ('booked_by', 'عميل مباشر', 15)
ON CONFLICT (setting_key, setting_value) DO NOTHING;
