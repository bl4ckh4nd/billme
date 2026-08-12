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
};

const HGB_GKV: CatalogProvenance = {
  version: 'HGB-2025-01-01',
  validFrom: '2025-01-01',
  validTo: '2025-12-31',
  sourceName: 'Gesetze im Internet – Handelsgesetzbuch § 275',
  sourceUrl: 'https://www.gesetze-im-internet.de/hgb/__275.html',
  sourceSha256: '3fa1ae0daa58ca663a835465fa8142089b79deaea73b83807c59354ca01fdcdc',
};

const BWA01: CatalogProvenance = {
  version: 'BWA01-public-2025-01-01',
  validFrom: '2025-01-01',
  validTo: '2025-12-31',
  sourceName: 'Bundesministerium für Wirtschaft und Klimaschutz – öffentliche BWA-01-Gliederung',
  sourceUrl: 'https://www.existenzgruendungsportal.de/Redaktion/DE/Downloads/DE/Checklisten-Uebersichten/Controlling/06-check-Betriebswirtschaftliche-Auswertung.pdf?__blob=publicationFile',
  // Reference hash only: DATEV account mappings are intentionally not part of this public catalog.
  sourceSha256: '06bebbb1374ca3913f9ac5c68c8c5830f1c2d3b878ea6636f9281ad21f58148d',
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
  position('BILANZ_B_III_2', 'assets.current.securities.own', 'Eigene Anteile', 43, 'line', 'assets.current.securities'),
  position('BILANZ_B_III_3', 'assets.current.securities.other', 'Sonstige Wertpapiere', 44, 'line', 'assets.current.securities'),
  position('BILANZ_B_IV', 'assets.current.cash', 'IV. Kassenbestand, Bundesbankguthaben, Guthaben bei Kreditinstituten und Schecks', 45, 'line', 'assets.current'),
  position('BILANZ_C', 'assets.prepaid', 'C. Rechnungsabgrenzungsposten', 50, 'line'),
  position('BILANZ_D', 'assets.deferred-tax', 'D. Aktive latente Steuern', 51, 'line'),
  position('BILANZ_E', 'assets.offset', 'E. Aktiver Unterschiedsbetrag aus der Vermögensverrechnung', 52, 'line'),
  position('BILANZ_F', 'assets.loss', 'F. Nicht durch Eigenkapital gedeckter Fehlbetrag', 53, 'line'),
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

const bwaPositions: PublicReportPosition[] = [
  position('BWA01_01', 'revenue', 'Umsatzerlöse', 1, 'line'),
  position('BWA01_02', 'inventory-change', 'Bestandsveränderungen', 2, 'line'),
  position('BWA01_03', 'capitalized-work', 'Aktivierte Eigenleistungen', 3, 'line'),
  position('BWA01_04', 'total-output', 'Gesamtleistung', 4, 'subtotal'),
  position('BWA01_05', 'material-expense', 'Wareneinsatz/Materialaufwand', 5, 'line'),
  position('BWA01_06', 'gross-profit', 'Rohertrag', 6, 'subtotal'),
  position('BWA01_07', 'personnel-expense', 'Personalkosten', 7, 'line'),
  position('BWA01_08', 'space-expense', 'Raumkosten', 8, 'line'),
  position('BWA01_09', 'insurance-contributions', 'Versicherungen/Beiträge', 9, 'line'),
  position('BWA01_10', 'vehicle-expense', 'Kfz-Kosten', 10, 'line'),
  position('BWA01_11', 'advertising-travel', 'Werbe-/Reisekosten', 11, 'line'),
  position('BWA01_12', 'cost-of-goods-out', 'Kosten der Warenabgabe', 12, 'line'),
  position('BWA01_13', 'depreciation', 'Abschreibungen', 13, 'line'),
  position('BWA01_14', 'maintenance', 'Reparatur/Instandhaltung', 14, 'line'),
  position('BWA01_15', 'other-operating-expense', 'Sonstige Kosten', 15, 'line'),
  position('BWA01_16', 'total-costs', 'Gesamtkosten', 16, 'subtotal'),
  position('BWA01_17', 'operating-result', 'Betriebsergebnis', 17, 'subtotal'),
  position('BWA01_18', 'interest-expense', 'Zinsaufwand', 18, 'line'),
  position('BWA01_19', 'neutral-expense', 'Neutraler Aufwand', 19, 'line'),
  position('BWA01_20', 'neutral-income', 'Neutraler Ertrag', 20, 'line'),
  position('BWA01_21', 'result-before-tax', 'Ergebnis vor Steuern', 21, 'subtotal'),
  position('BWA01_22', 'income-tax', 'Steuern vom Einkommen und Ertrag', 22, 'line'),
  position('BWA01_23', 'preliminary-result', 'Vorläufiges Ergebnis', 23, 'result'),
];

const catalog = (
  id: string,
  title: string,
  kind: PublicReportCatalog['kind'],
  scope: PublicReportCatalog['scope'],
  provenance: CatalogProvenance,
  positions: PublicReportPosition[],
): PublicReportCatalog => {
  const result = { id, title, kind, scope, provenance, positions, mappingStatus: 'public-structure-only' as const };
  validatePublicReportCatalog(result);
  return result;
};

export const PUBLIC_HGB_BILANZ_MICRO_2025 = catalog('hgb-bilanz-micro-2025', 'HGB-Bilanz – Kleinstkapitalgesellschaften', 'bilanz', 'micro', HGB_BILANZ, bilanzPositions);
export const PUBLIC_HGB_BILANZ_SMALL_2025 = catalog('hgb-bilanz-small-2025', 'HGB-Bilanz – kleine Kapitalgesellschaften', 'bilanz', 'small', HGB_BILANZ, bilanzPositions);
export const PUBLIC_HGB_GKV_MICRO_2025 = catalog('hgb-gkv-micro-2025', 'HGB-Gewinn- und Verlustrechnung (Gesamtkostenverfahren) – Kleinstkapitalgesellschaften', 'gkv', 'micro', HGB_GKV, gkvPositions);
export const PUBLIC_HGB_GKV_SMALL_2025 = catalog('hgb-gkv-small-2025', 'HGB-Gewinn- und Verlustrechnung (Gesamtkostenverfahren) – kleine Kapitalgesellschaften', 'gkv', 'small', HGB_GKV, gkvPositions);
export const PUBLIC_BWA01_MICRO_2025 = catalog('bwa01-micro-2025', 'BWA 01 – öffentliche Positionsstruktur für Kleinstunternehmen', 'bwa01', 'micro', BWA01, bwaPositions);
export const PUBLIC_BWA01_SMALL_2025 = catalog('bwa01-small-2025', 'BWA 01 – öffentliche Positionsstruktur für kleine Unternehmen', 'bwa01', 'small', BWA01, bwaPositions);

export const getPublicReportCatalogs = (year: number): PublicReportCatalog[] => {
  if (year !== 2025) throw new Error(`PUBLIC_REPORT_CATALOG_UNAVAILABLE:${year}`);
  return [
    PUBLIC_HGB_BILANZ_MICRO_2025,
    PUBLIC_HGB_BILANZ_SMALL_2025,
    PUBLIC_HGB_GKV_MICRO_2025,
    PUBLIC_HGB_GKV_SMALL_2025,
    PUBLIC_BWA01_MICRO_2025,
    PUBLIC_BWA01_SMALL_2025,
  ];
};

