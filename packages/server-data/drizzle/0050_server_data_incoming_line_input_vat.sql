-- Non-deductible input VAT (§ 15 Abs. 1a UStG, e.g. Geschenke über 50 €, unangemessene Bewirtung): an incoming
-- invoice line can say its VAT is not deductible; it is then booked with the expense instead of as Vorsteuer.
-- NULL keeps the old meaning (deductible).
ALTER TABLE incoming_invoice_lines ADD COLUMN IF NOT EXISTS input_vat_deductible BOOLEAN;
