-- A bank line booked again after its Storno: a draft keeps one live journal entry, the reversed original and its Storno stay.
DROP INDEX IF EXISTS uq_journal_entries_source_draft;
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_source_draft ON journal_entries (tenant_id, source_draft_id) WHERE source_draft_id IS NOT NULL AND status = 'posted';
