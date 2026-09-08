import {
  BalanceSheetPreview,
  GuvLine,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSelection,
  ReportFilterState,
  SusaReport,
  SusaRow,
} from '../domain/reportTypes';
import {
  mockBalanceSheetPreviewBase,
  mockDrilldownEntriesByAccount,
  mockGuvReportBase,
  mockSusaReportBase,
} from '../mocks/reports';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareMultiplier(compareMode: ReportFilterState['compareMode']) {
  if (compareMode === 'prev_period') return 0.94;
  if (compareMode === 'prev_year') return 0.86;
  return 1;
}

function periodMultiplier(filters: ReportFilterState) {
  if (filters.periodPreset === 'prev_year' || filters.compareMode === 'prev_year') return 0.86;
  if (filters.periodPreset === 'ytd') return 0.72;
  return 1;
}

function scaledReport(report: GuvReport, multiplier: number): GuvReport {
  const scale = (lines: GuvLine[]): GuvLine[] => lines.map((line) => ({
    ...line,
    amountCurrent: Math.round(line.amountCurrent * multiplier * 100) / 100,
    amountCompare: line.amountCompare === undefined ? undefined : Math.round(line.amountCompare * multiplier * 100) / 100,
    children: line.children ? scale(line.children) : undefined,
  }));
  return {
    ...report,
    lines: scale(report.lines),
    totals: {
      revenue: Math.round(report.totals.revenue * multiplier * 100) / 100,
      expenses: Math.round(report.totals.expenses * multiplier * 100) / 100,
      result: Math.round(report.totals.result * multiplier * 100) / 100,
    },
    quality: { ...report.quality, generatedAt: new Date().toISOString() },
  };
}

function chartLabelAdjust(accountName: string, chart: 'SKR03' | 'SKR04') {
  return chart === 'SKR04' ? `${accountName} (SKR04)` : accountName;
}

export async function getSusaReport(filters: ReportFilterState): Promise<SusaReport> {
  const report = clone(mockSusaReportBase);
  report.rows = report.rows
    .map((row) => ({
      ...row,
      accountName: chartLabelAdjust(row.accountName, filters.chart),
      debitTurnover: Math.round(row.debitTurnover * (filters.includeDrafts ? 1.02 : 1) * 100) / 100,
      creditTurnover: Math.round(row.creditTurnover * (filters.includeDrafts ? 1.01 : 1) * 100) / 100,
    }))
    .filter((row) => filters.chart === 'SKR03' || row.accountNumber !== '9000');

  report.quality.generatedAt = new Date().toISOString();
  report.quality.warnings = report.rows.filter((r) => r.hasWarnings).length;
  report.quality.unmappedAccounts = report.rows.filter((r) => !r.mappedTo).length;
  report.totals = calculateSusaTotals(report.rows);
  return report;
}

function calculateSusaTotals(rows: SusaRow[]): SusaReport['totals'] {
  const totals = {
    openingDebit: 0,
    openingCredit: 0,
    turnoverDebit: 0,
    turnoverCredit: 0,
    closingDebit: 0,
    closingCredit: 0,
  };
  rows.forEach((r) => {
    if (r.openingBalance >= 0) totals.openingDebit += r.openingBalance;
    else totals.openingCredit += Math.abs(r.openingBalance);
    totals.turnoverDebit += r.debitTurnover;
    totals.turnoverCredit += r.creditTurnover;
    if (r.closingBalance >= 0) totals.closingDebit += r.closingBalance;
    else totals.closingCredit += Math.abs(r.closingBalance);
  });
  return totals;
}

function adjustGuvLines(lines: GuvLine[], compareMode: ReportFilterState['compareMode']): GuvLine[] {
  const mult = compareMultiplier(compareMode);
  return lines.map((line) => ({
    ...line,
    amountCompare: compareMode === 'none' ? undefined : Math.round((line.amountCurrent * mult) * 100) / 100,
    children: line.children ? adjustGuvLines(line.children, compareMode) : undefined,
  }));
}

export async function getGuvReport(filters: ReportFilterState): Promise<GuvReport> {
  const report = clone(mockGuvReportBase);
  report.lines = adjustGuvLines(report.lines, filters.compareMode);
  const flatten = flattenGuv(report.lines);
  report.totals = {
    revenue: flatten.filter((l) => l.amountCurrent > 0).reduce((s, l) => s + l.amountCurrent, 0),
    expenses: Math.abs(flatten.filter((l) => l.amountCurrent < 0).reduce((s, l) => s + l.amountCurrent, 0)),
    result: flatten.find((l) => l.id === 'guv-8')?.amountCurrent ?? 0,
  };
  report.quality.generatedAt = new Date().toISOString();
  return report;
}

export async function getEurReport(filters: ReportFilterState): Promise<GuvReport> {
  const report = await getGuvReport(filters);
  return scaledReport(report, periodMultiplier(filters));
}

export async function getBwaReport(filters: ReportFilterState): Promise<GuvReport> {
  const report = await getGuvReport(filters);
  return scaledReport(report, periodMultiplier(filters));
}

export async function getManagementGuvReport(filters: ReportFilterState): Promise<GuvReport> {
  const report = await getGuvReport(filters);
  return scaledReport(report, periodMultiplier(filters));
}

export async function getHgbGuvReport(filters: ReportFilterState): Promise<GuvReport> {
  const report = await getGuvReport(filters);
  return scaledReport(report, periodMultiplier(filters));
}

function flattenGuv(lines: GuvLine[]): GuvLine[] {
  return lines.flatMap((line) => [line, ...(line.children ? flattenGuv(line.children) : [])]);
}

export async function getBalanceSheetPreview(filters: ReportFilterState): Promise<BalanceSheetPreview> {
  const report = clone(mockBalanceSheetPreviewBase);
  if (filters.includeDrafts) {
    report.totals.passiva += 120;
    report.totals.difference = Math.round((report.totals.aktiva - report.totals.passiva) * 100) / 100;
    report.quality.status = 'warning';
    report.quality.notes = [
      'Entwürfe einbezogen: Preview-Differenz enthält noch ungebuchte Vorgänge.',
      ...report.quality.notes,
    ];
  } else {
    report.totals.difference = 0;
    report.quality.status = 'ok';
  }
  report.quality.generatedAt = new Date().toISOString();
  return report;
}

export async function getReportDrilldownEntries(selection: ReportDrilldownSelection): Promise<ReportDrilldownEntry[]> {
  const keys = selection.accountNumbers.length ? selection.accountNumbers : [selection.targetId];
  const rows = keys.flatMap((k) => mockDrilldownEntriesByAccount[k] ?? []);
  return clone(rows).sort((a, b) => a.date.localeCompare(b.date));
}
