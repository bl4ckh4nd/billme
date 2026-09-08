import type {
  BalanceSheetPreview,
  GuvLine,
  GuvReport,
  ReportFilterState,
  ReportTabId,
  SusaReport,
} from './reportTypes';

export type ReportExportCell = string | number | null | undefined;

export interface NormalizedReport {
  title: string;
  metadata: Readonly<Record<string, string>>;
  columns: readonly string[];
  rows: readonly (readonly ReportExportCell[])[];
}

const reportTitles: Record<ReportTabId, string> = {
  eur: 'Einnahmenüberschussrechnung',
  susa: 'Summen- und Saldenliste',
  bwa01: 'BWA01',
  management_guv: 'Management-GuV',
  hgb_guv: 'Gewinn- und Verlustrechnung nach HGB',
  bilanz: 'Bilanz nach HGB',
};

const euro = (value: number): string => new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value);

const filterMetadata = (filters: ReportFilterState, generatedAt: string | undefined): Record<string, string> => ({
  Stichtag: filters.asOfDate,
  'Zeitraum von': filters.periodFromDate ?? filters.periodFrom ?? '',
  'Zeitraum bis': filters.periodToDate ?? filters.periodTo ?? '',
  Kontenrahmen: filters.chart,
  ...(filters.compareMode !== 'none' ? { Vergleich: filters.compareMode } : {}),
  ...(generatedAt ? { Stand: generatedAt } : {}),
});

const flattenGuvLines = (lines: readonly GuvLine[], level = 0): Array<{ line: GuvLine; level: number }> =>
  lines.flatMap((line) => [
    { line, level },
    ...(line.children?.length ? flattenGuvLines(line.children, level + 1) : []),
  ]);

const isSusaReport = (report: unknown): report is SusaReport => Boolean(
  report
  && typeof report === 'object'
  && Array.isArray((report as SusaReport).rows)
  && 'totals' in report
  && 'quality' in report,
);

const isGuvReport = (report: unknown): report is GuvReport => Boolean(
  report
  && typeof report === 'object'
  && Array.isArray((report as GuvReport).lines)
  && 'totals' in report
  && 'quality' in report,
);

const isBalanceSheetReport = (report: unknown): report is BalanceSheetPreview => Boolean(
  report
  && typeof report === 'object'
  && Array.isArray((report as BalanceSheetPreview).aktiva)
  && Array.isArray((report as BalanceSheetPreview).passiva)
  && 'totals' in report
  && 'quality' in report,
);

const susaTotalsRow = (report: SusaReport): readonly ReportExportCell[] => [
  'Summen',
  '',
  euro(report.totals.openingDebit - report.totals.openingCredit),
  euro(report.totals.turnoverDebit),
  euro(report.totals.turnoverCredit),
  euro(report.totals.closingDebit - report.totals.closingCredit),
  '',
  '',
];

/**
 * Converts the current report snapshot into one deliberately boring export shape.
 * The adapter remains responsible for authoritative exports; this is only the
 * browser fallback when no adapter exporter is available.
 */
export const normalizeReportSnapshot = (
  reportType: ReportTabId,
  report: unknown,
  filters: ReportFilterState,
): NormalizedReport => {
  if (!report || typeof report !== 'object') throw new Error('Der aktuelle Report enthält keine exportierbaren Daten.');
  const title = reportTitles[reportType];
  const generatedAt = 'quality' in report && report.quality && typeof report.quality === 'object' && 'generatedAt' in report.quality
    ? String(report.quality.generatedAt ?? '')
    : undefined;
  const metadata = filterMetadata(filters, generatedAt);

  if (reportType === 'susa') {
    if (!isSusaReport(report)) throw new Error('Der aktuelle SuSa-Report hat ein unbekanntes Format.');
    return {
      title,
      metadata,
      columns: ['Konto', 'Bezeichnung', 'Anfang', 'Soll', 'Haben', 'Ende', 'Mapping', 'Hinweise'],
      rows: [
        ...report.rows.map((row) => [
          row.accountNumber,
          row.accountName,
          euro(row.openingBalance),
          euro(row.debitTurnover),
          euro(row.creditTurnover),
          euro(row.closingBalance),
          row.mappedTo ?? 'Ungemappt',
          row.hasWarnings ? 'Prüfen' : '',
        ]),
        susaTotalsRow(report),
      ],
    };
  }

  if (reportType === 'bilanz') {
    if (!isBalanceSheetReport(report)) throw new Error('Der aktuelle Bilanz-Report hat ein unbekanntes Format.');
    return {
      title,
      metadata,
      columns: ['Seite', 'Position', 'Bezeichnung', 'Betrag'],
      rows: [
        ...report.aktiva.map((line) => ['Aktiva', line.code, line.label, euro(line.amount)]),
        ...report.passiva.map((line) => ['Passiva', line.code, line.label, euro(line.amount)]),
        ['Aktiva', '', 'Aktiva gesamt', euro(report.totals.aktiva)],
        ['Passiva', '', 'Passiva gesamt', euro(report.totals.passiva)],
        ['', '', 'Differenz', euro(report.totals.difference)],
      ],
    };
  }

  if (!isGuvReport(report)) throw new Error('Der aktuelle GuV-Report hat ein unbekanntes Format.');
  const hasComparison = report.lines.some((line) => line.amountCompare !== undefined);
  return {
    title,
    metadata,
    columns: hasComparison ? ['Position', 'Aktuell', 'Vergleich'] : ['Position', 'Aktuell'],
    rows: [
      ...flattenGuvLines(report.lines).map(({ line, level }) => [
        `${'  '.repeat(level)}${line.code} ${line.label}`.trim(),
        euro(line.amountCurrent),
        ...(hasComparison ? [line.amountCompare === undefined ? '' : euro(line.amountCompare)] : []),
      ]),
      ['Umsätze gesamt', euro(report.totals.revenue), ...(hasComparison ? [''] : [])],
      ['Aufwendungen gesamt', euro(report.totals.expenses), ...(hasComparison ? [''] : [])],
      ['Ergebnis', euro(report.totals.result), ...(hasComparison ? [''] : [])],
    ],
  };
};

const looksLikeFormattedAmount = (text: string): boolean =>
  /^-?(?:\d{1,3}(?:\.\d{3})*|\d+)(?:,\d{2})$/.test(text.trim());

const csvCell = (value: ReportExportCell): string => {
  const rawText = value === null || value === undefined ? '' : String(value);
  const formulaPrefix = rawText.match(/^(\s*)([=+@-])/);
  const text = typeof value === 'string' && formulaPrefix
    && !(rawText.trim().startsWith('-') && looksLikeFormattedAmount(rawText))
    ? `${formulaPrefix[1]}'${rawText.slice(formulaPrefix[1].length)}`
    : rawText;
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Serializes a normalized report as UTF-8 CSV with a German-compatible delimiter. */
export const reportToCsv = (report: NormalizedReport): string => {
  const metadataRows = Object.entries(report.metadata).map(([key, value]) => [key, value]);
  const rows: readonly (readonly ReportExportCell[])[] = [
    [report.title],
    ...metadataRows,
    [],
    report.columns,
    ...report.rows,
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
};

export const reportFileName = (reportType: ReportTabId, format: 'pdf' | 'csv'): string =>
  `report-${reportType}.${format}`;

/** Starts a browser download without ever passing report content through HTML. */
export const downloadReportCsv = (content: string, fileName: string): void => {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('CSV-Download ist in dieser Umgebung nicht verfügbar.');
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const appendText = (parent: Element, tag: string, text: string, className?: string): HTMLElement => {
  const element = parent.ownerDocument.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
};

const appendTable = (documentRef: Document, root: HTMLElement, report: NormalizedReport): void => {
  const table = documentRef.createElement('table');
  const head = table.createTHead().insertRow();
  for (const column of report.columns) appendText(head, 'th', column);
  const body = table.createTBody();
  for (const row of report.rows) {
    const tableRow = body.insertRow();
    for (const value of row) appendText(tableRow, 'td', value === null || value === undefined ? '' : String(value));
  }
  root.appendChild(table);
};

const printDocumentStyles = `
  :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; color: #0b0b0b; background: #fff; }
  body { margin: 32px; font-size: 12px; }
  h1 { margin: 0 0 18px; font-size: 20px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 22px; }
  dt { font-weight: 700; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
  th { background: #f9fafb; font-weight: 700; }
  @page { size: A4 portrait; margin: 12mm; }
`;

const waitForFrame = (): Promise<void> => new Promise((resolve) => {
  const requestFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
  requestFrame(() => requestFrame(() => resolve()));
});

/**
 * Opens Chromium's print dialog for an isolated report document. The promise
 * settles once Chromium accepts the print call; afterprint performs cleanup
 * for both dialog confirmation and cancellation.
 */
export const printReportPdf = async (report: NormalizedReport): Promise<void> => {
  if (typeof document === 'undefined' || !document.body) throw new Error('PDF-Druck ist in dieser Umgebung nicht verfügbar.');
  const iframe = document.createElement('iframe');
  iframe.title = `${report.title} drucken`;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';

  document.body.appendChild(iframe);
  const printWindow = iframe.contentWindow;
  const printDocument = iframe.contentDocument;
  if (!printWindow || !printDocument) {
    iframe.remove();
    throw new Error('Das isolierte Druckdokument konnte nicht erstellt werden.');
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
  };

  try {
    const style = printDocument.createElement('style');
    style.textContent = printDocumentStyles;
    printDocument.head.appendChild(style);
    const root = printDocument.createElement('main');
    printDocument.body.appendChild(root);
    appendText(root, 'h1', report.title);
    const metadata = printDocument.createElement('dl');
    for (const [key, value] of Object.entries(report.metadata)) {
      appendText(metadata, 'dt', key);
      appendText(metadata, 'dd', value);
    }
    root.appendChild(metadata);
    appendTable(printDocument, root, report);
    printDocument.close();

    await new Promise<void>((resolve) => {
      if (printDocument.readyState === 'complete') resolve();
      else iframe.addEventListener('load', () => resolve(), { once: true });
    });
    if (printDocument.fonts?.ready) await printDocument.fonts.ready;
    await waitForFrame();

    await new Promise<void>((resolve, reject) => {
      const onAfterPrint = () => {
        printWindow.removeEventListener('afterprint', onAfterPrint);
        cleanup();
      };
      if (typeof printWindow.print !== 'function') {
        cleanup();
        reject(new Error('PDF-Druck ist in dieser Umgebung nicht verfügbar.'));
        return;
      }
      printWindow.addEventListener('afterprint', onAfterPrint, { once: true });
      try {
        printWindow.print();
        // Chromium dispatches afterprint for both confirmation and cancel. The
        // action itself is already observable once print() returns, so callers
        // must not remain busy while the native dialog is open.
        resolve();
      } catch (error) {
        printWindow.removeEventListener('afterprint', onAfterPrint);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch (error) {
    cleanup();
    throw error;
  }
};
