-- Preserve DATEV Sachverhalt L+L on immutable journal lines. Existing
-- installations receive this column incrementally; new installations run it
-- after the baseline journal schema as well.
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS datev_sachverhalt_ll TEXT;
ALTER TABLE booking_draft_lines ADD COLUMN IF NOT EXISTS datev_sachverhalt_ll TEXT;
