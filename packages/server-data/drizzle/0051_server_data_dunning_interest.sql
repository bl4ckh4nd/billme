-- Verzugszinsen (§ 288 BGB) claimed in a dunning letter: the history row keeps the interest this letter added, so
-- Pro books it once (Forderung an Zinserträge) and the next letter books only what accrued since. NULL = none.
ALTER TABLE dunning_history ADD COLUMN IF NOT EXISTS interest_applied NUMERIC;
