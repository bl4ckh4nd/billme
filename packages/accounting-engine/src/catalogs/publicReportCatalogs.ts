import {
  validatePublicReportCatalog,
  type CatalogProvenance,
  type PublicReportCatalog,
  type PublicReportPosition,
} from './types';

const HGB_BILANZ: CatalogProvenance = {
  version: 'HGB-2025-01-01',
  validFrom: '2025-01-01',
  validTo: '2025-12-31',
  sourceName: 'Gesetze im Internet – Handelsgesetzbuch § 266',
  sourceUrl: 'https://www.gesetze-im-internet.de/hgb/__266.html',
  sourceSha256: '7905132dcbdb537815d5d9b5deab5c97b6bc053b9ada21e16dd1c92d7a551ffe',
  sourceHashStatus: 'verified',
};

const HGB_GKV: CatalogProvenance = {
  version: 'HGB-2025-01-01',
  validFrom: '2025-01-01',
  validTo: '2025-12-31',
  sourceName: 'Gesetze im Internet – Handelsgesetzbuch § 275',
  sourceUrl: 'https://www.gesetze-im-internet.de/hgb/__275.html',
  sourceSha256: '3fa1ae0daa58ca663a835465fa8142089b79deaea73b83807c59354ca01fdcdc',
  sourceHashStatus: 'verified',
};

// The BMJ pages were rechecked on 2026-08-12.  Their §266/§275 structures
// remain unchanged, but the report catalog is still versioned by applicable
// year so a later legal change cannot silently reuse this snapshot.
const HGB_BILANZ_2026: CatalogProvenance = {
  ...HGB_BILANZ,
  version: 'HGB-2026-01-01',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
};

const HGB_GKV_2026: CatalogProvenance = {
  ...HGB_GKV,
  version: 'HGB-2026-01-01',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
};

const BWA01: CatalogProvenance = {
  version: 'BMWi-GründerZeiten-23-2021-01',
  validFrom: '2021-01-01',
  sourceName: 'Bundesministerium für Wirtschaft und Energie – GründerZeiten 23 Controlling',
  sourceUrl: 'https://www.existenzgruendungsportal.de/Redaktion/DE/Downloads/DE/GruenderZeiten/GruenderZeiten-23.pdf?__blob=publicationFile',
  sourceSha256: '28976588a6a429db8b6c457c07225dae55e10d271ffc1ae37d6d25fc60b60163',
  sourceHashStatus: 'verified',
};

// BWA 01 is a non-statutory controlling layout, not a tax or HGB form.  The
// 2021 source remains the evidence; this immutable 2026 applicability
// snapshot deliberately does not present it as a new legal publication.
const BWA01_2026: CatalogProvenance = {
  ...BWA01,
  version: 'BMWi-GründerZeiten-23-2021-01-applicable-2026',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  sourceName: `${BWA01.sourceName} (nicht gesetzliche Orientierungsstruktur)`,
};

const both = ['micro', 'small'] as const;
const position = (
  id: string,
  key: string,
  label: string,
  order: number,
  kind: PublicReportPosition['kind'],
  parentKey?: string,
): PublicReportPosition => ({ id, key, label, order, kind, parentKey, scopes: [...both] });

const bilanzPositions: PublicReportPosition[] = [
  position('BILANZ_A', 'assets.non-current', 'A. Anlagevermögen', 10, 'heading'),
  position('BILANZ_A_I', 'assets.non-current.intangible', 'I. Immaterielle Vermögensgegenstände', 11, 'line', 'assets.non-current'),
  position('BILANZ_A_II', 'assets.non-current.tangible', 'II. Sachanlagen', 12, 'heading', 'assets.non-current'),
  position('BILANZ_A_II_1', 'assets.non-current.tangible.land', 'Grundstücke, grundstücksgleiche Rechte und Bauten einschließlich der Bauten auf fremden Grundstücken', 13, 'line', 'assets.non-current.tangible'),
  position('BILANZ_A_II_2', 'assets.non-current.tangible.machinery', 'Technische Anlagen und Maschinen', 14, 'line', 'assets.non-current.tangible'),
  position('BILANZ_A_II_3', 'assets.non-current.tangible.equipment', 'Andere Anlagen, Betriebs- und Geschäftsausstattung', 15, 'line', 'assets.non-current.tangible'),
  position('BILANZ_A_II_4', 'assets.non-current.tangible.construction', 'Geleistete Anzahlungen und Anlagen im Bau', 16, 'line', 'assets.non-current.tangible'),
  position('BILANZ_A_III', 'assets.non-current.financial', 'III. Finanzanlagen', 17, 'heading', 'assets.non-current'),
  position('BILANZ_A_III_1', 'assets.non-current.financial.affiliates', 'Anteile an verbundenen Unternehmen', 18, 'line', 'assets.non-current.financial'),
  position('BILANZ_A_III_2', 'assets.non-current.financial.loans-affiliates', 'Ausleihungen an verbundene Unternehmen', 19, 'line', 'assets.non-current.financial'),
  position('BILANZ_A_III_3', 'assets.non-current.financial.participations', 'Beteiligungen', 20, 'line', 'assets.non-current.financial'),
  position('BILANZ_A_III_4', 'assets.non-current.financial.loans-participations', 'Ausleihungen an Unternehmen, mit denen ein Beteiligungsverhältnis besteht', 21, 'line', 'assets.non-current.financial'),
  position('BILANZ_A_III_5', 'assets.non-current.financial.securities', 'Wertpapiere des Anlagevermögens', 22, 'line', 'assets.non-current.financial'),
  position('BILANZ_A_III_6', 'assets.non-current.financial.loans-other', 'Sonstige Ausleihungen', 23, 'line', 'assets.non-current.financial'),
  position('BILANZ_B', 'assets.current', 'B. Umlaufvermögen', 30, 'heading'),
  position('BILANZ_B_I', 'assets.current.inventory', 'I. Vorräte', 31, 'heading', 'assets.current'),
  position('BILANZ_B_I_1', 'assets.current.inventory.materials', 'Roh-, Hilfs- und Betriebsstoffe', 32, 'line', 'assets.current.inventory'),
  position('BILANZ_B_I_2', 'assets.current.inventory.work-in-progress', 'Unfertige Erzeugnisse, unfertige Leistungen', 33, 'line', 'assets.current.inventory'),
  position('BILANZ_B_I_3', 'assets.current.inventory.finished', 'Fertige Erzeugnisse und Waren', 34, 'line', 'assets.current.inventory'),
  position('BILANZ_B_I_4', 'assets.current.inventory.advances', 'Geleistete Anzahlungen', 35, 'line', 'assets.current.inventory'),
  position('BILANZ_B_II', 'assets.current.receivables', 'II. Forderungen und sonstige Vermögensgegenstände', 36, 'heading', 'assets.current'),
  position('BILANZ_B_II_1', 'assets.current.receivables.trade', 'Forderungen aus Lieferungen und Leistungen', 37, 'line', 'assets.current.receivables'),
  position('BILANZ_B_II_2', 'assets.current.receivables.affiliates', 'Forderungen gegen verbundene Unternehmen', 38, 'line', 'assets.current.receivables'),
  position('BILANZ_B_II_3', 'assets.current.receivables.participations', 'Forderungen gegen Unternehmen, mit denen ein Beteiligungsverhältnis besteht', 39, 'line', 'assets.current.receivables'),
  position('BILANZ_B_II_4', 'assets.current.receivables.other', 'Sonstige Vermögensgegenstände', 40, 'line', 'assets.current.receivables'),
  position('BILANZ_B_III', 'assets.current.securities', 'III. Wertpapiere', 41, 'heading', 'assets.current'),
  position('BILANZ_B_III_1', 'assets.current.securities.affiliates', 'Anteile an verbundenen Unternehmen', 42, 'line', 'assets.current.securities'),
  position('BILANZ_B_III_2', 'assets.current.securities.other', 'Sonstige Wertpapiere', 43, 'line', 'assets.current.securities'),
  position('BILANZ_B_IV', 'assets.current.cash', 'IV. Kassenbestand, Bundesbankguthaben, Guthaben bei Kreditinstituten und Schecks', 44, 'line', 'assets.current'),
  position('BILANZ_C', 'assets.prepaid', 'C. Rechnungsabgrenzungsposten', 50, 'line'),
  position('BILANZ_D', 'assets.deferred-tax', 'D. Aktive latente Steuern', 51, 'line'),
  position('BILANZ_E', 'assets.offset', 'E. Aktiver Unterschiedsbetrag aus der Vermögensverrechnung', 52, 'line'),
  position('BILANZ_PA', 'equity', 'A. Eigenkapital', 60, 'heading'),
  position('BILANZ_PA_1', 'equity.subscribed', 'Gezeichnetes Kapital', 61, 'line', 'equity'),
  position('BILANZ_PA_2', 'equity.capital-reserve', 'Kapitalrücklage', 62, 'line', 'equity'),
  position('BILANZ_PA_3', 'equity.revenue-reserves', 'Gewinnrücklagen', 63, 'line', 'equity'),
  position('BILANZ_PA_4', 'equity.profit-loss-forward', 'Gewinnvortrag/Verlustvortrag', 64, 'line', 'equity'),
  position('BILANZ_PA_5', 'equity.result', 'Jahresüberschuss/Jahresfehlbetrag', 65, 'result', 'equity'),
  position('BILANZ_PB', 'provisions', 'B. Rückstellungen', 70, 'heading'),
  position('BILANZ_PB_1', 'provisions.pensions', 'Rückstellungen für Pensionen und ähnliche Verpflichtungen', 71, 'line', 'provisions'),
  position('BILANZ_PB_2', 'provisions.tax', 'Steuerrückstellungen', 72, 'line', 'provisions'),
  position('BILANZ_PB_3', 'provisions.other', 'Sonstige Rückstellungen', 73, 'line', 'provisions'),
  position('BILANZ_PC', 'liabilities', 'C. Verbindlichkeiten', 80, 'heading'),
  position('BILANZ_PC_1', 'liabilities.bonds', 'Anleihen', 81, 'line', 'liabilities'),
  position('BILANZ_PC_2', 'liabilities.bank', 'Verbindlichkeiten gegenüber Kreditinstituten', 82, 'line', 'liabilities'),
  position('BILANZ_PC_3', 'liabilities.advances', 'Erhaltene Anzahlungen auf Bestellungen', 83, 'line', 'liabilities'),
  position('BILANZ_PC_4', 'liabilities.trade', 'Verbindlichkeiten aus Lieferungen und Leistungen', 84, 'line', 'liabilities'),
  position('BILANZ_PC_5', 'liabilities.accepted-bills', 'Verbindlichkeiten aus Wechseln', 85, 'line', 'liabilities'),
  position('BILANZ_PC_6', 'liabilities.affiliates', 'Verbindlichkeiten gegenüber verbundenen Unternehmen', 86, 'line', 'liabilities'),
  position('BILANZ_PC_7', 'liabilities.participations', 'Verbindlichkeiten gegenüber Unternehmen, mit denen ein Beteiligungsverhältnis besteht', 87, 'line', 'liabilities'),
  position('BILANZ_PC_8', 'liabilities.other', 'Sonstige Verbindlichkeiten', 88, 'line', 'liabilities'),
  position('BILANZ_PD', 'liabilities.prepaid', 'D. Rechnungsabgrenzungsposten', 90, 'line'),
  position('BILANZ_PE', 'liabilities.deferred-tax', 'E. Passive latente Steuern', 91, 'line'),
];

const gkvPositions: PublicReportPosition[] = [
  position('GKV_01', 'revenue', '1. Umsatzerlöse', 1, 'line'),
  position('GKV_02', 'inventory-change', '2. Erhöhung oder Verminderung des Bestands an fertigen und unfertigen Erzeugnissen', 2, 'line'),
  position('GKV_03', 'capitalized-work', '3. Andere aktivierte Eigenleistungen', 3, 'line'),
  position('GKV_04', 'other-operating-income', '4. Sonstige betriebliche Erträge', 4, 'line'),
  position('GKV_05', 'material', '5. Materialaufwand', 5, 'heading'),
  position('GKV_05A', 'material.raw', 'a) Aufwendungen für Roh-, Hilfs- und Betriebsstoffe und für bezogene Waren', 6, 'line', 'material'),
  position('GKV_05B', 'material.services', 'b) Aufwendungen für bezogene Leistungen', 7, 'line', 'material'),
  position('GKV_06', 'personnel', '6. Personalaufwand', 8, 'heading'),
  position('GKV_06A', 'personnel.wages', 'a) Löhne und Gehälter', 9, 'line', 'personnel'),
  position('GKV_06B', 'personnel.social', 'b) Soziale Abgaben und Aufwendungen für Altersversorgung und für Unterstützung', 10, 'line', 'personnel'),
  position('GKV_07', 'depreciation', '7. Abschreibungen', 11, 'heading'),
  position('GKV_07A', 'depreciation.intangible-tangible', 'a) auf immaterielle Vermögensgegenstände des Anlagevermögens und Sachanlagen', 12, 'line', 'depreciation'),
  position('GKV_07B', 'depreciation.current-assets', 'b) auf Vermögensgegenstände des Umlaufvermögens, soweit diese die üblichen Abschreibungen überschreiten', 13, 'line', 'depreciation'),
  position('GKV_08', 'other-operating-expense', '8. Sonstige betriebliche Aufwendungen', 14, 'line'),
  position('GKV_09', 'investment-income', '9. Erträge aus Beteiligungen', 15, 'line'),
  position('GKV_10', 'securities-income', '10. Erträge aus anderen Wertpapieren und Ausleihungen des Finanzanlagevermögens', 16, 'line'),
  position('GKV_11', 'interest-income', '11. Sonstige Zinsen und ähnliche Erträge', 17, 'line'),
  position('GKV_12', 'financial-depreciation', '12. Abschreibungen auf Finanzanlagen und auf Wertpapiere des Umlaufvermögens', 18, 'line'),
  position('GKV_13', 'interest-expense', '13. Zinsen und ähnliche Aufwendungen', 19, 'line'),
  position('GKV_14', 'income-tax', '14. Steuern vom Einkommen und vom Ertrag', 20, 'line'),
  position('GKV_15', 'result-after-tax', '15. Ergebnis nach Steuern', 21, 'subtotal'),
  position('GKV_16', 'other-tax', '16. Sonstige Steuern', 22, 'line'),
  position('GKV_17', 'annual-result', '17. Jahresüberschuss/Jahresfehlbetrag', 23, 'result'),
];

const bilanzSmallKeys = new Set([
  'assets.non-current',
  'assets.non-current.intangible',
  'assets.non-current.tangible',
  'assets.non-current.financial',
  'assets.current',
  'assets.current.inventory',
  'assets.current.receivables',
  'assets.current.securities',
  'assets.current.cash',
  'assets.prepaid',
  'assets.deferred-tax',
  'assets.offset',
  'equity',
  'equity.subscribed',
  'equity.capital-reserve',
  'equity.revenue-reserves',
  'equity.profit-loss-forward',
  'equity.result',
  'provisions',
  'liabilities',
  'liabilities.prepaid',
  'liabilities.deferred-tax',
]);
const bilanzMicroKeys = new Set([
  'assets.non-current',
  'assets.current',
  'assets.prepaid',
  'assets.deferred-tax',
  'assets.offset',
  'equity',
  'provisions',
  'liabilities',
  'liabilities.prepaid',
  'liabilities.deferred-tax',
]);
const bilanzSmallPositions = bilanzPositions.filter((entry) => bilanzSmallKeys.has(entry.key));
const bilanzMicroPositions = bilanzPositions.filter((entry) => bilanzMicroKeys.has(entry.key));

const bwaPositions: PublicReportPosition[] = [
  position('BWA01_01', 'revenue', 'Umsatzerlöse', 1, 'line'),
  position('BWA01_02', 'total-output', 'Gesamtleistung', 2, 'subtotal'),
  position('BWA01_03', 'material-expense', 'Material/Wareneinkauf', 3, 'line'),
  position('BWA01_04', 'gross-profit', 'Rohertrag', 4, 'subtotal'),
  position('BWA01_05', 'special-operating-income', 'Sonderbetriebserlöse', 5, 'line'),
  position('BWA01_06', 'operating-gross-profit', 'Betrieblicher Rohertrag', 6, 'subtotal'),
  position('BWA01_07', 'personnel-expense', 'Personalkosten', 7, 'line'),
  position('BWA01_08', 'space-expense', 'Raumkosten', 8, 'line'),
  position('BWA01_09', 'operating-tax', 'Betriebliche Steuern', 9, 'line'),
  position('BWA01_10', 'insurance', 'Versicherungen', 10, 'line'),
  position('BWA01_11', 'special-cost', 'Besondere Kosten', 11, 'line'),
  position('BWA01_12', 'vehicle-expense', 'Kfz-Kosten (ohne Steuern)', 12, 'line'),
  position('BWA01_13', 'advertising-travel', 'Werbe-/Reisekosten', 13, 'line'),
  position('BWA01_14', 'cost-of-goods-out', 'Kosten Warenabgabe', 14, 'line'),
  position('BWA01_15', 'depreciation', 'Abschreibungen', 15, 'line'),
  position('BWA01_16', 'maintenance', 'Reparatur/Instandhaltung', 16, 'line'),
  position('BWA01_17', 'other-operating-expense', 'Sonstige Kosten', 17, 'line'),
  position('BWA01_18', 'total-costs', 'Gesamtkosten', 18, 'subtotal'),
  position('BWA01_19', 'operating-result', 'Betriebsergebnis', 19, 'subtotal'),
  position('BWA01_20', 'interest-expense', 'Zinsaufwand', 20, 'line'),
  position('BWA01_21', 'other-neutral-expense', 'Sonstige neutrale Aufwände', 21, 'line'),
  position('BWA01_22', 'neutral-expense', 'Neutraler Aufwand', 22, 'subtotal'),
  position('BWA01_23', 'interest-income', 'Zinserträge', 23, 'line'),
  position('BWA01_24', 'other-neutral-income', 'Sonstige neutrale Erträge', 24, 'line'),
  position('BWA01_25', 'imputed-cost-offset', 'Verrechnung kalkulatorischer Kosten', 25, 'line'),
  position('BWA01_26', 'neutral-income', 'Neutraler Ertrag', 26, 'subtotal'),
  position('BWA01_27', 'result-before-tax', 'Ergebnis vor Steuern', 27, 'subtotal'),
  position('BWA01_28', 'income-tax', 'Steuern', 28, 'line'),
  position('BWA01_29', 'preliminary-result', 'Vorläufiges Ergebnis', 29, 'result'),
];

// Internal management reporting is intentionally separate from the statutory
// HGB catalogues and from the public BWA source.  Its formulas stay in the
// engine, while this catalog owns the complete, explicit position set.
export const managementGuvPositions: PublicReportPosition[] = [
  position('MGMT_GUV_01', 'revenue', 'Betriebliche Erlöse', 1, 'line'),
  position('MGMT_GUV_02', 'variable-costs', 'Variable Kosten', 2, 'line'),
  position('MGMT_GUV_03', 'contribution-margin', 'Deckungsbeitrag', 3, 'subtotal'),
  position('MGMT_GUV_04', 'personnel-costs', 'Personalkosten', 4, 'line'),
  position('MGMT_GUV_05', 'fixed-costs', 'Fixkosten', 5, 'line'),
  position('MGMT_GUV_06', 'ebitda', 'EBITDA', 6, 'subtotal'),
  position('MGMT_GUV_07', 'depreciation', 'Abschreibungen', 7, 'line'),
  position('MGMT_GUV_08', 'ebit', 'EBIT', 8, 'subtotal'),
  position('MGMT_GUV_09', 'financial-result', 'Finanzergebnis', 9, 'line'),
  position('MGMT_GUV_10', 'taxes', 'Steuern', 10, 'line'),
  position('MGMT_GUV_11', 'net-result', 'Managementergebnis', 11, 'result'),
];

const MANAGEMENT_GUV_2025: CatalogProvenance = {
  version: 'BillMe-Management-GuV-2025-01-01',
  validFrom: '2025-01-01',
  validTo: '2025-12-31',
  sourceName: 'BillMe – interne Management-GuV (nicht gesetzliche Steuerungsrechnung)',
  sourceUrl: 'https://github.com/bl4ckh4nd/billme',
  // SHA-256 of the canonical position manifest in this module.  This is an
  // internal model digest, not a claim that the layout is statutory.
  sourceSha256: '15e6bf6310e87568d91cda4b99fb4a26a17f6e589e6461127cf401866f3f564e',
  sourceHashStatus: 'verified',
};

const MANAGEMENT_GUV_2026: CatalogProvenance = {
  ...MANAGEMENT_GUV_2025,
  version: 'BillMe-Management-GuV-2026-01-01',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
};

const catalog = (
  id: string,
  title: string,
  kind: PublicReportCatalog['kind'],
  scope: PublicReportCatalog['scope'],
  provenance: CatalogProvenance,
  positions: PublicReportPosition[],
  verifySource = true,
): PublicReportCatalog => {
  const result = {
    id,
    title,
    kind,
    scope,
    provenance,
    positions: positions.map((entry) => ({ ...entry, scopes: [scope] })),
    mappingStatus: 'public-structure-only' as const,
  };
  if (verifySource) validatePublicReportCatalog(result);
  return result;
};

export const PUBLIC_HGB_BILANZ_MICRO_2025 = catalog('hgb-bilanz-micro-2025', 'HGB-Bilanz – Kleinstkapitalgesellschaften (Mindestgliederung A–E)', 'bilanz', 'micro', HGB_BILANZ, bilanzMicroPositions);
export const PUBLIC_HGB_BILANZ_SMALL_2025 = catalog('hgb-bilanz-small-2025', 'HGB-Bilanz – kleine Kapitalgesellschaften (Buchstaben und römische Ziffern)', 'bilanz', 'small', HGB_BILANZ, bilanzSmallPositions);
export const PUBLIC_HGB_GKV_MICRO_2025 = catalog('hgb-gkv-micro-2025', 'HGB-Gewinn- und Verlustrechnung (Gesamtkostenverfahren) – Kleinstkapitalgesellschaften', 'gkv', 'micro', HGB_GKV, gkvPositions);
export const PUBLIC_HGB_GKV_SMALL_2025 = catalog('hgb-gkv-small-2025', 'HGB-Gewinn- und Verlustrechnung (Gesamtkostenverfahren) – kleine Kapitalgesellschaften', 'gkv', 'small', HGB_GKV, gkvPositions);
export const PUBLIC_BWA01_MICRO_2021 = catalog('bwa01-micro-2021', 'BWA 01 – öffentliche Positionsstruktur für Kleinstunternehmen (Stand Januar 2021)', 'bwa01', 'micro', BWA01, bwaPositions);
export const PUBLIC_BWA01_SMALL_2021 = catalog('bwa01-small-2021', 'BWA 01 – öffentliche Positionsstruktur für kleine Unternehmen (Stand Januar 2021)', 'bwa01', 'small', BWA01, bwaPositions);

export const PUBLIC_HGB_BILANZ_MICRO_2026 = catalog('hgb-bilanz-micro-2026', 'HGB-Bilanz – Kleinstkapitalgesellschaften (Mindestgliederung A–E)', 'bilanz', 'micro', HGB_BILANZ_2026, bilanzMicroPositions);
export const PUBLIC_HGB_BILANZ_SMALL_2026 = catalog('hgb-bilanz-small-2026', 'HGB-Bilanz – kleine Kapitalgesellschaften (Buchstaben und römische Ziffern)', 'bilanz', 'small', HGB_BILANZ_2026, bilanzSmallPositions);
export const PUBLIC_HGB_GKV_MICRO_2026 = catalog('hgb-gkv-micro-2026', 'HGB-Gewinn- und Verlustrechnung (Gesamtkostenverfahren) – Kleinstkapitalgesellschaften', 'gkv', 'micro', HGB_GKV_2026, gkvPositions);
export const PUBLIC_HGB_GKV_SMALL_2026 = catalog('hgb-gkv-small-2026', 'HGB-Gewinn- und Verlustrechnung (Gesamtkostenverfahren) – kleine Kapitalgesellschaften', 'gkv', 'small', HGB_GKV_2026, gkvPositions);
export const PUBLIC_BWA01_MICRO_2026 = catalog('bwa01-micro-2026', 'BWA 01 – öffentliche Positionsstruktur für Kleinstunternehmen (nicht gesetzliche Orientierungsstruktur, 2026)', 'bwa01', 'micro', BWA01_2026, bwaPositions);
export const PUBLIC_BWA01_SMALL_2026 = catalog('bwa01-small-2026', 'BWA 01 – öffentliche Positionsstruktur für kleine Unternehmen (nicht gesetzliche Orientierungsstruktur, 2026)', 'bwa01', 'small', BWA01_2026, bwaPositions);

export const PUBLIC_MANAGEMENT_GUV_MICRO_2025 = catalog('management-guv-micro-2025', 'Interne Management-GuV – Kleinstunternehmen (nicht gesetzliche Steuerungsrechnung)', 'management-guv', 'micro', MANAGEMENT_GUV_2025, managementGuvPositions);
export const PUBLIC_MANAGEMENT_GUV_SMALL_2025 = catalog('management-guv-small-2025', 'Interne Management-GuV – kleine Unternehmen (nicht gesetzliche Steuerungsrechnung)', 'management-guv', 'small', MANAGEMENT_GUV_2025, managementGuvPositions);
export const PUBLIC_MANAGEMENT_GUV_MICRO_2026 = catalog('management-guv-micro-2026', 'Interne Management-GuV – Kleinstunternehmen (nicht gesetzliche Steuerungsrechnung, 2026)', 'management-guv', 'micro', MANAGEMENT_GUV_2026, managementGuvPositions);
export const PUBLIC_MANAGEMENT_GUV_SMALL_2026 = catalog('management-guv-small-2026', 'Interne Management-GuV – kleine Unternehmen (nicht gesetzliche Steuerungsrechnung, 2026)', 'management-guv', 'small', MANAGEMENT_GUV_2026, managementGuvPositions);

export const getPublicReportCatalogs = (year: number): PublicReportCatalog[] => {
  if (year === 2025) {
    return [
      PUBLIC_HGB_BILANZ_MICRO_2025,
      PUBLIC_HGB_BILANZ_SMALL_2025,
      PUBLIC_HGB_GKV_MICRO_2025,
      PUBLIC_HGB_GKV_SMALL_2025,
      PUBLIC_BWA01_MICRO_2021,
      PUBLIC_BWA01_SMALL_2021,
    ];
  }
  if (year === 2026) {
    return [
      PUBLIC_HGB_BILANZ_MICRO_2026,
      PUBLIC_HGB_BILANZ_SMALL_2026,
      PUBLIC_HGB_GKV_MICRO_2026,
      PUBLIC_HGB_GKV_SMALL_2026,
      PUBLIC_BWA01_MICRO_2026,
      PUBLIC_BWA01_SMALL_2026,
    ];
  }
  throw new Error(`PUBLIC_REPORT_CATALOG_UNAVAILABLE:${year}`);
};

export const getManagementReportCatalogs = (year: number): PublicReportCatalog[] => {
  if (year === 2025) return [PUBLIC_MANAGEMENT_GUV_MICRO_2025, PUBLIC_MANAGEMENT_GUV_SMALL_2025];
  if (year === 2026) return [PUBLIC_MANAGEMENT_GUV_MICRO_2026, PUBLIC_MANAGEMENT_GUV_SMALL_2026];
  throw new Error(`PUBLIC_REPORT_CATALOG_UNAVAILABLE:${year}`);
};

// Compatibility name retained for report consumers; all returned catalogs are verified.
export const getPublicReportCatalogsIncludingUnverified = (year: number): PublicReportCatalog[] => {
  return getPublicReportCatalogs(year);
};
