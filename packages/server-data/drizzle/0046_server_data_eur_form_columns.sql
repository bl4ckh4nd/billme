-- Anlage EÜR, checked against the BMF forms 2025 (29.08.2025) and 2026 (01.09.2026):
-- 1. The limited-deduction columns were labelled the wrong way round: Kz 164/165/162/168 are the
--    "nicht abziehbar" column, Kz 174/175/172/177 the "abziehbar" one. Users chose a line by its label,
--    so every stored choice on those ids is swapped pairwise to keep what the user meant.
-- 2. Kz 159 / 199 sum as on the form: the "davon" lines (119 in 111, 153 in 151) and the non-deductible
--    columns stay out; Kz 142 and 139 are subtracted.
-- 3. Labels with real umlauts; the 2026 catalog names the published BMF letter of 01.09.2026.
-- Frozen EÜR snapshots keep their payload.

UPDATE eur_lines SET label='Davon nicht steuerbare Umsätze sowie Umsätze nach § 19 Abs. 2 Satz 1 Nr. 1 und 2 sowie Satz 2 UStG (in Kz 111 enthalten)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ119';
UPDATE eur_lines SET label='Veräußerung oder Entnahme von Anlagevermögen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ102';
UPDATE eur_lines SET label='Summe Betriebseinnahmen', computed_from_json='[]', computed_terms_json='[{"id":"E2025_KZ111","sign":1},{"id":"E2025_KZ104","sign":1},{"id":"E2025_KZ112","sign":1},{"id":"E2025_KZ103","sign":1},{"id":"E2025_KZ140","sign":1},{"id":"E2025_KZ141","sign":1},{"id":"E2025_KZ102","sign":1},{"id":"E2025_KZ106","sign":1},{"id":"E2025_KZ108","sign":1}]', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ159';
UPDATE eur_lines SET label='Betriebsausgabenpauschale für bestimmte Berufsgruppen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ195';
UPDATE eur_lines SET label='Waren, Rohstoffe und Hilfsstoffe einschließlich Nebenkosten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ100';
UPDATE eur_lines SET label='Ausgaben für eigenes Personal', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ120';
UPDATE eur_lines SET label='AfA auf Grundstücke/grundstücksgleiche Rechte', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ136';
UPDATE eur_lines SET label='AfA auf immaterielle Wirtschaftsgüter', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ131';
UPDATE eur_lines SET label='AfA auf bewegliche Wirtschaftsgüter', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ130';
UPDATE eur_lines SET label='Herabsetzungsbeträge nach § 7g Abs. 2 Satz 3 EStG', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ138';
UPDATE eur_lines SET label='Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ132';
UPDATE eur_lines SET label='Auflösung Sammelposten nach § 6 Abs. 2a EStG', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ137';
UPDATE eur_lines SET label='Restbuchwerte ausgeschiedener Anlagegüter', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ135';
UPDATE eur_lines SET label='Miete/Pacht für Geschäftsräume und betrieblich genutzte Grundstücke', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ150';
UPDATE eur_lines SET label='Aufwendungen für doppelte Haushaltsführung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ152';
UPDATE eur_lines SET label='Sonstige Aufwendungen für betrieblich genutzte Grundstücke', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ151';
UPDATE eur_lines SET label='In Kz 151 enthaltene Erhaltungsaufwendungen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ153';
UPDATE eur_lines SET label='Aufwendungen für Telekommunikation', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ280';
UPDATE eur_lines SET label='Übernachtungs- und Reisenebenkosten bei Geschäftsreisen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ221';
UPDATE eur_lines SET label='Kosten für Rechts- und Steuerberatung, Buchführung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ194';
UPDATE eur_lines SET label='Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kfz)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ222';
UPDATE eur_lines SET label='Erhaltungsaufwendungen (ohne Gebäude und Kfz)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ225';
UPDATE eur_lines SET label='Beiträge, Gebühren, Abgaben und Versicherungen (ohne Gebäude und Kfz)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ223';
UPDATE eur_lines SET label='Kosten für Abfallbeseitigung und Entsorgung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ226';
UPDATE eur_lines SET label='Kosten für Verpackung und Transport', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ227';
UPDATE eur_lines SET label='Schuldzinsen für Anlagevermögen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ232';
UPDATE eur_lines SET label='Übrige Schuldzinsen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ234';
UPDATE eur_lines SET label='Gezahlte und nach § 15 UStG abziehbare Vorsteuerbeträge', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ185';
UPDATE eur_lines SET label='Übrige unbeschränkt abziehbare Betriebsausgaben', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ183';
UPDATE eur_lines SET label='Geschenke (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ164';
UPDATE eur_lines SET label='Geschenke (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ174';
UPDATE eur_lines SET label='Bewirtungsaufwendungen (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ165';
UPDATE eur_lines SET label='Bewirtungsaufwendungen (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ175';
UPDATE eur_lines SET label='Aufwendungen für ein häusliches Arbeitszimmer (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ162';
UPDATE eur_lines SET label='Aufwendungen für ein häusliches Arbeitszimmer (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ172';
UPDATE eur_lines SET label='Tagespauschale für die Tätigkeit in der häuslichen Wohnung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ163';
UPDATE eur_lines SET label='Sonstige beschränkt abziehbare Betriebsausgaben (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ168';
UPDATE eur_lines SET label='Sonstige beschränkt abziehbare Betriebsausgaben (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ177';
UPDATE eur_lines SET label='Kfz-/Fahrtkosten sonstige tatsächliche Kosten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ146';
UPDATE eur_lines SET label='Fahrtkosten für nicht zum Betriebsvermögen gehörende Fahrzeuge', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ147';
UPDATE eur_lines SET label='Fahrtkosten Wohnung-erste Betriebsstätte/Familienheimfahrten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ142';
UPDATE eur_lines SET label='Mindestens abziehbare Fahrtkosten Wohnung-erste Betriebsstätte/Familienheimfahrten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ176';
UPDATE eur_lines SET label='Nicht abziehbare Beträge', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ139';
UPDATE eur_lines SET label='Summe Betriebsausgaben', computed_from_json='[]', computed_terms_json='[{"id":"E2025_KZ195","sign":1},{"id":"E2025_KZ100","sign":1},{"id":"E2025_KZ110","sign":1},{"id":"E2025_KZ120","sign":1},{"id":"E2025_KZ136","sign":1},{"id":"E2025_KZ131","sign":1},{"id":"E2025_KZ130","sign":1},{"id":"E2025_KZ134","sign":1},{"id":"E2025_KZ138","sign":1},{"id":"E2025_KZ132","sign":1},{"id":"E2025_KZ137","sign":1},{"id":"E2025_KZ135","sign":1},{"id":"E2025_KZ150","sign":1},{"id":"E2025_KZ152","sign":1},{"id":"E2025_KZ151","sign":1},{"id":"E2025_KZ280","sign":1},{"id":"E2025_KZ221","sign":1},{"id":"E2025_KZ281","sign":1},{"id":"E2025_KZ194","sign":1},{"id":"E2025_KZ222","sign":1},{"id":"E2025_KZ225","sign":1},{"id":"E2025_KZ223","sign":1},{"id":"E2025_KZ228","sign":1},{"id":"E2025_KZ229","sign":1},{"id":"E2025_KZ226","sign":1},{"id":"E2025_KZ227","sign":1},{"id":"E2025_KZ224","sign":1},{"id":"E2025_KZ232","sign":1},{"id":"E2025_KZ234","sign":1},{"id":"E2025_KZ185","sign":1},{"id":"E2025_KZ186","sign":1},{"id":"E2025_KZ183","sign":1},{"id":"E2025_KZ174","sign":1},{"id":"E2025_KZ175","sign":1},{"id":"E2025_KZ171","sign":1},{"id":"E2025_KZ172","sign":1},{"id":"E2025_KZ163","sign":1},{"id":"E2025_KZ177","sign":1},{"id":"E2025_KZ144","sign":1},{"id":"E2025_KZ145","sign":1},{"id":"E2025_KZ146","sign":1},{"id":"E2025_KZ147","sign":1},{"id":"E2025_KZ142","sign":-1},{"id":"E2025_KZ176","sign":1},{"id":"E2025_KZ139","sign":-1}]', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2025_KZ199';
UPDATE eur_lines SET label='Davon nicht steuerbare Umsätze sowie Umsätze nach § 19 Abs. 2 Satz 1 Nr. 1 und 2 sowie Satz 2 UStG (in Kz 111 enthalten)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ119';
UPDATE eur_lines SET label='Veräußerung oder Entnahme von Anlagevermögen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ102';
UPDATE eur_lines SET label='Summe Betriebseinnahmen', computed_from_json='[]', computed_terms_json='[{"id":"E2026_KZ111","sign":1},{"id":"E2026_KZ104","sign":1},{"id":"E2026_KZ112","sign":1},{"id":"E2026_KZ103","sign":1},{"id":"E2026_KZ140","sign":1},{"id":"E2026_KZ141","sign":1},{"id":"E2026_KZ102","sign":1},{"id":"E2026_KZ106","sign":1},{"id":"E2026_KZ108","sign":1}]', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ159';
UPDATE eur_lines SET label='Betriebsausgabenpauschale für bestimmte Berufsgruppen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ195';
UPDATE eur_lines SET label='Waren, Rohstoffe und Hilfsstoffe einschließlich Nebenkosten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ100';
UPDATE eur_lines SET label='Ausgaben für eigenes Personal', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ120';
UPDATE eur_lines SET label='AfA auf Grundstücke/grundstücksgleiche Rechte', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ136';
UPDATE eur_lines SET label='AfA auf immaterielle Wirtschaftsgüter', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ131';
UPDATE eur_lines SET label='AfA auf bewegliche Wirtschaftsgüter', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ130';
UPDATE eur_lines SET label='Herabsetzungsbeträge nach § 7g Abs. 2 Satz 3 EStG', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ138';
UPDATE eur_lines SET label='Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ132';
UPDATE eur_lines SET label='Auflösung Sammelposten nach § 6 Abs. 2a EStG', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ137';
UPDATE eur_lines SET label='Restbuchwerte ausgeschiedener Anlagegüter', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ135';
UPDATE eur_lines SET label='Miete/Pacht für Geschäftsräume und betrieblich genutzte Grundstücke', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ150';
UPDATE eur_lines SET label='Aufwendungen für doppelte Haushaltsführung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ152';
UPDATE eur_lines SET label='Sonstige Aufwendungen für betrieblich genutzte Grundstücke', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ151';
UPDATE eur_lines SET label='In Kz 151 enthaltene Erhaltungsaufwendungen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ153';
UPDATE eur_lines SET label='Aufwendungen für Telekommunikation', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ280';
UPDATE eur_lines SET label='Übernachtungs- und Reisenebenkosten bei Geschäftsreisen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ221';
UPDATE eur_lines SET label='Kosten für Rechts- und Steuerberatung, Buchführung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ194';
UPDATE eur_lines SET label='Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kfz)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ222';
UPDATE eur_lines SET label='Erhaltungsaufwendungen (ohne Gebäude und Kfz)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ225';
UPDATE eur_lines SET label='Beiträge, Gebühren, Abgaben und Versicherungen (ohne Gebäude und Kfz)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ223';
UPDATE eur_lines SET label='Kosten für Abfallbeseitigung und Entsorgung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ226';
UPDATE eur_lines SET label='Kosten für Verpackung und Transport', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ227';
UPDATE eur_lines SET label='Schuldzinsen für Anlagevermögen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ232';
UPDATE eur_lines SET label='Übrige Schuldzinsen', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ234';
UPDATE eur_lines SET label='Gezahlte und nach § 15 UStG abziehbare Vorsteuerbeträge', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ185';
UPDATE eur_lines SET label='Übrige unbeschränkt abziehbare Betriebsausgaben', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ183';
UPDATE eur_lines SET label='Geschenke (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ164';
UPDATE eur_lines SET label='Geschenke (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ174';
UPDATE eur_lines SET label='Bewirtungsaufwendungen (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ165';
UPDATE eur_lines SET label='Bewirtungsaufwendungen (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ175';
UPDATE eur_lines SET label='Aufwendungen für ein häusliches Arbeitszimmer (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ162';
UPDATE eur_lines SET label='Aufwendungen für ein häusliches Arbeitszimmer (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ172';
UPDATE eur_lines SET label='Tagespauschale für die Tätigkeit in der häuslichen Wohnung', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ163';
UPDATE eur_lines SET label='Sonstige beschränkt abziehbare Betriebsausgaben (nicht abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ168';
UPDATE eur_lines SET label='Sonstige beschränkt abziehbare Betriebsausgaben (abziehbar)', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ177';
UPDATE eur_lines SET label='Kfz-/Fahrtkosten sonstige tatsächliche Kosten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ146';
UPDATE eur_lines SET label='Fahrtkosten für nicht zum Betriebsvermögen gehörende Fahrzeuge', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ147';
UPDATE eur_lines SET label='Fahrtkosten Wohnung-erste Betriebsstätte/Familienheimfahrten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ142';
UPDATE eur_lines SET label='Mindestens abziehbare Fahrtkosten Wohnung-erste Betriebsstätte/Familienheimfahrten', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ176';
UPDATE eur_lines SET label='Nicht abziehbare Beträge', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ139';
UPDATE eur_lines SET label='Summe Betriebsausgaben', computed_from_json='[]', computed_terms_json='[{"id":"E2026_KZ195","sign":1},{"id":"E2026_KZ100","sign":1},{"id":"E2026_KZ110","sign":1},{"id":"E2026_KZ120","sign":1},{"id":"E2026_KZ136","sign":1},{"id":"E2026_KZ131","sign":1},{"id":"E2026_KZ130","sign":1},{"id":"E2026_KZ134","sign":1},{"id":"E2026_KZ138","sign":1},{"id":"E2026_KZ132","sign":1},{"id":"E2026_KZ137","sign":1},{"id":"E2026_KZ135","sign":1},{"id":"E2026_KZ150","sign":1},{"id":"E2026_KZ152","sign":1},{"id":"E2026_KZ151","sign":1},{"id":"E2026_KZ280","sign":1},{"id":"E2026_KZ221","sign":1},{"id":"E2026_KZ281","sign":1},{"id":"E2026_KZ194","sign":1},{"id":"E2026_KZ222","sign":1},{"id":"E2026_KZ225","sign":1},{"id":"E2026_KZ223","sign":1},{"id":"E2026_KZ228","sign":1},{"id":"E2026_KZ229","sign":1},{"id":"E2026_KZ226","sign":1},{"id":"E2026_KZ227","sign":1},{"id":"E2026_KZ224","sign":1},{"id":"E2026_KZ232","sign":1},{"id":"E2026_KZ234","sign":1},{"id":"E2026_KZ185","sign":1},{"id":"E2026_KZ186","sign":1},{"id":"E2026_KZ183","sign":1},{"id":"E2026_KZ174","sign":1},{"id":"E2026_KZ175","sign":1},{"id":"E2026_KZ171","sign":1},{"id":"E2026_KZ172","sign":1},{"id":"E2026_KZ163","sign":1},{"id":"E2026_KZ177","sign":1},{"id":"E2026_KZ144","sign":1},{"id":"E2026_KZ145","sign":1},{"id":"E2026_KZ146","sign":1},{"id":"E2026_KZ147","sign":1},{"id":"E2026_KZ142","sign":-1},{"id":"E2026_KZ176","sign":1},{"id":"E2026_KZ139","sign":-1}]', updated_at=CURRENT_TIMESTAMP::text WHERE id='E2026_KZ199';
UPDATE eur_lines SET source_version='BMF-2026-2026-09-01' WHERE tax_year=2026 AND source_version='BMF-2026-2026-08-14';

UPDATE eur_classifications SET eur_line_id=CASE WHEN eur_line_id LIKE '%\_KZ164' THEN regexp_replace(eur_line_id, '_KZ164$', '_KZ174') WHEN eur_line_id LIKE '%\_KZ174' THEN regexp_replace(eur_line_id, '_KZ174$', '_KZ164') WHEN eur_line_id LIKE '%\_KZ165' THEN regexp_replace(eur_line_id, '_KZ165$', '_KZ175') WHEN eur_line_id LIKE '%\_KZ175' THEN regexp_replace(eur_line_id, '_KZ175$', '_KZ165') WHEN eur_line_id LIKE '%\_KZ162' THEN regexp_replace(eur_line_id, '_KZ162$', '_KZ172') WHEN eur_line_id LIKE '%\_KZ172' THEN regexp_replace(eur_line_id, '_KZ172$', '_KZ162') WHEN eur_line_id LIKE '%\_KZ168' THEN regexp_replace(eur_line_id, '_KZ168$', '_KZ177') WHEN eur_line_id LIKE '%\_KZ177' THEN regexp_replace(eur_line_id, '_KZ177$', '_KZ168') ELSE eur_line_id END WHERE eur_line_id IN ('E2025_KZ164','E2025_KZ174','E2025_KZ165','E2025_KZ175','E2025_KZ162','E2025_KZ172','E2025_KZ168','E2025_KZ177','E2026_KZ164','E2026_KZ174','E2026_KZ165','E2026_KZ175','E2026_KZ162','E2026_KZ172','E2026_KZ168','E2026_KZ177');
UPDATE eur_cash_facts SET eur_line_id=CASE WHEN eur_line_id LIKE '%\_KZ164' THEN regexp_replace(eur_line_id, '_KZ164$', '_KZ174') WHEN eur_line_id LIKE '%\_KZ174' THEN regexp_replace(eur_line_id, '_KZ174$', '_KZ164') WHEN eur_line_id LIKE '%\_KZ165' THEN regexp_replace(eur_line_id, '_KZ165$', '_KZ175') WHEN eur_line_id LIKE '%\_KZ175' THEN regexp_replace(eur_line_id, '_KZ175$', '_KZ165') WHEN eur_line_id LIKE '%\_KZ162' THEN regexp_replace(eur_line_id, '_KZ162$', '_KZ172') WHEN eur_line_id LIKE '%\_KZ172' THEN regexp_replace(eur_line_id, '_KZ172$', '_KZ162') WHEN eur_line_id LIKE '%\_KZ168' THEN regexp_replace(eur_line_id, '_KZ168$', '_KZ177') WHEN eur_line_id LIKE '%\_KZ177' THEN regexp_replace(eur_line_id, '_KZ177$', '_KZ168') ELSE eur_line_id END WHERE eur_line_id IN ('E2025_KZ164','E2025_KZ174','E2025_KZ165','E2025_KZ175','E2025_KZ162','E2025_KZ172','E2025_KZ168','E2025_KZ177','E2026_KZ164','E2026_KZ174','E2026_KZ165','E2026_KZ175','E2026_KZ162','E2026_KZ172','E2026_KZ168','E2026_KZ177');
UPDATE eur_rules SET target_eur_line_id=CASE WHEN target_eur_line_id LIKE '%\_KZ164' THEN regexp_replace(target_eur_line_id, '_KZ164$', '_KZ174') WHEN target_eur_line_id LIKE '%\_KZ174' THEN regexp_replace(target_eur_line_id, '_KZ174$', '_KZ164') WHEN target_eur_line_id LIKE '%\_KZ165' THEN regexp_replace(target_eur_line_id, '_KZ165$', '_KZ175') WHEN target_eur_line_id LIKE '%\_KZ175' THEN regexp_replace(target_eur_line_id, '_KZ175$', '_KZ165') WHEN target_eur_line_id LIKE '%\_KZ162' THEN regexp_replace(target_eur_line_id, '_KZ162$', '_KZ172') WHEN target_eur_line_id LIKE '%\_KZ172' THEN regexp_replace(target_eur_line_id, '_KZ172$', '_KZ162') WHEN target_eur_line_id LIKE '%\_KZ168' THEN regexp_replace(target_eur_line_id, '_KZ168$', '_KZ177') WHEN target_eur_line_id LIKE '%\_KZ177' THEN regexp_replace(target_eur_line_id, '_KZ177$', '_KZ168') ELSE target_eur_line_id END WHERE target_eur_line_id IN ('E2025_KZ164','E2025_KZ174','E2025_KZ165','E2025_KZ175','E2025_KZ162','E2025_KZ172','E2025_KZ168','E2025_KZ177','E2026_KZ164','E2026_KZ174','E2026_KZ165','E2026_KZ175','E2026_KZ162','E2026_KZ172','E2026_KZ168','E2026_KZ177');
UPDATE eur_cash_facts SET splits_json=replace(replace(replace(replace(replace(replace(replace(replace(replace(splits_json, '_KZ164"', '_KZ#174"'), '_KZ174"', '_KZ#164"'), '_KZ165"', '_KZ#175"'), '_KZ175"', '_KZ#165"'), '_KZ162"', '_KZ#172"'), '_KZ172"', '_KZ#162"'), '_KZ168"', '_KZ#177"'), '_KZ177"', '_KZ#168"'), '_KZ#', '_KZ') WHERE splits_json ~ '_KZ(164|165|162|168|174|175|172|177)"';

-- Lite: how a manual entry was paid. 'bank' and 'cash' are money; 'non_cash' is a booking without a payment
-- (Pauschale, AfA, Privatanteil). Entries made before stay NULL and are named as unknown in the DATEV export.
ALTER TABLE lite_cash_entries ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE lite_cash_entries DROP CONSTRAINT IF EXISTS lite_cash_entries_payment_method_check;
ALTER TABLE lite_cash_entries ADD CONSTRAINT lite_cash_entries_payment_method_check CHECK (payment_method IS NULL OR payment_method IN ('bank', 'cash', 'non_cash'));
