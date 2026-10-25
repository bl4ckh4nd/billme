-- "Regelmäßig wiederkehrend" on a Lite bank line (§ 11 Abs. 1 S. 2 / Abs. 2 S. 2 EStG): the user asserts the payment
-- recurs and fell due around the year end, so a line paid 22.12.–10.01. counts in the neighbouring year. NULL = not marked.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurring BOOLEAN;
