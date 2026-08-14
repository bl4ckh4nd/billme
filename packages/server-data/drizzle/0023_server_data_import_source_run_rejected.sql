-- Desktop accounting runs include rejected validation attempts. Preserve them
-- during SQLite import instead of dropping or relabeling their status.
ALTER TABLE accounting_source_runs
  DROP CONSTRAINT IF EXISTS accounting_source_runs_status_check;
ALTER TABLE accounting_source_runs
  ADD CONSTRAINT accounting_source_runs_status_check
  CHECK (status IN ('posted', 'prepared', 'rejected', 'noop'));
