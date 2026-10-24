-- Soll = Haben is a database invariant, not only an application check.
-- Every journal entry written in a transaction must have at least two lines whose
-- debit and credit totals are equal and positive when that transaction commits
-- (constraint triggers, deferred to commit so lines can follow their entry).
-- Lines can only be written together with their entry: appending to an entry
-- that an earlier transaction committed is refused, even as a balanced pair.
-- Existing rows are not re-checked; the triggers apply to new writes only.

CREATE OR REPLACE FUNCTION billme_assert_journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_entry TEXT;
  line_count INTEGER;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_entry := NEW.id;
  ELSE
    target_entry := NEW.entry_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = target_entry AND tenant_id = NEW.tenant_id) THEN
    RETURN NULL;
  END IF;
  SELECT COUNT(*), COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0)
    INTO line_count, debit_total, credit_total
    FROM journal_lines WHERE entry_id = target_entry AND tenant_id = NEW.tenant_id;
  IF line_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'UNBALANCED_ENTRY: journal entry % does not balance (debit %, credit %, % lines)', target_entry, debit_total, credit_total, line_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_entries_balanced ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billme_assert_journal_entry_balanced();

DROP TRIGGER IF EXISTS journal_lines_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billme_assert_journal_entry_balanced();

-- The entry row's xmin is the id of the transaction that wrote it. No code path
-- uses savepoints, so an entry of the current transaction carries the current
-- top-level transaction id.
CREATE OR REPLACE FUNCTION billme_guard_journal_line_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_xmin TEXT;
BEGIN
  SELECT xmin::text INTO entry_xmin FROM journal_entries WHERE id = NEW.entry_id AND tenant_id = NEW.tenant_id;
  IF entry_xmin IS NOT NULL AND entry_xmin <> (txid_current() % 4294967296)::text THEN
    RAISE EXCEPTION 'JOURNAL_ENTRY_ALREADY_POSTED: lines cannot be added to the posted journal entry %', NEW.entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_lines_insert_guard ON journal_lines;
CREATE TRIGGER journal_lines_insert_guard BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION billme_guard_journal_line_insert();
