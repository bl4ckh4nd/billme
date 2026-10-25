import React from 'react';
import {
  Button, Card, EMPTY_VALUE, EmptyState, ErrorState, Metric, Select,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useActionFeedback,
} from '@billme/ui';
import { defaultEurTaxYear, eurTaxYearOptions, LATEST_SUPPORTED_EUR_TAX_YEAR } from '@billme/accounting-shared';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { ipc } from '../runtime-api';
import { Spinner } from '../ui/components/Spinner';

const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

const triggerCsvDownload = (content: string, fileName: string): void => {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const pad2 = (value: number) => String(value).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
/** 'year', 'q1'..'q4' or 'm1'..'m12' → ISO range inside the tax year (DATEV wants one Wirtschaftsjahr per file). */
const datevRange = (year: number, period: string): { from: string; to: string } => {
  const [first, last] = period === 'year' ? [1, 12]
    : period.startsWith('q') ? [Number(period.slice(1)) * 3 - 2, Number(period.slice(1)) * 3]
      : [Number(period.slice(1)), Number(period.slice(1))];
  return { from: `${year}-${pad2(first)}-01`, to: `${year}-${pad2(last)}-${pad2(lastDay(year, last))}` };
};
type DatevExportResult = Awaited<ReturnType<typeof ipc.eur.exportDatev>>;

/** Anlage EÜR for one tax year: totals, lines by Kennziffer, CSV, PDF and DATEV export. */
export const EurReportPanel: React.FC = () => {
  const [taxYear, setTaxYear] = React.useState<number>(() => defaultEurTaxYear());
  const [isPdfExporting, setIsPdfExporting] = React.useState(false);
  const [datevPeriod, setDatevPeriod] = React.useState('year');
  const [isDatevExporting, setIsDatevExporting] = React.useState(false);
  const [datevResult, setDatevResult] = React.useState<DatevExportResult | null>(null);
  const { notify } = useActionFeedback('eur-report');
  const [showEmptyRows, setShowEmptyRows] = React.useState(false);
  // The coming year can be prepared early; it is computed with the newest published form.
  const yearOptions = React.useMemo(() => [...new Set([defaultEurTaxYear() + 1, ...eurTaxYearOptions()])].sort((a, b) => b - a), []);
  const { data: report, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['eur', 'report', taxYear],
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });

  // Master data (Kalenderjahr, Steuernummer, Art des Betriebs) is no amount; empty lines only on request.
  const visibleRows = (report?.rows ?? []).filter((row) => row.providerPath !== 'general' && (showEmptyRows || row.total !== 0));

  const exportCsv = async () => {
    try {
      triggerCsvDownload(await ipc.eur.exportCsv({ taxYear }), `anlage-euer-${taxYear}.csv`);
    } catch {
      notify('error', 'CSV-Export fehlgeschlagen');
    }
  };
  const exportPdf = async () => {
    setIsPdfExporting(true);
    try {
      const res = await ipc.eur.exportPdf({ taxYear });
      notify('success', `PDF gespeichert: ${res.path}`);
    } catch {
      notify('error', 'PDF-Export fehlgeschlagen');
    } finally {
      setIsPdfExporting(false);
    }
  };

  const exportDatev = async () => {
    setIsDatevExporting(true);
    try {
      const result = await ipc.eur.exportDatev(datevRange(taxYear, datevPeriod));
      const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'text/csv;charset=windows-1252' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setDatevResult(result);
      notify(result.errors.length ? 'info' : 'success', result.errors.length
        ? `DATEV-Export mit ${result.rowCount} Buchungen; ${result.errors.length} Posten fehlen.`
        : `DATEV-Export mit ${result.rowCount} Buchungen gespeichert.`);
    } catch (exportError) {
      notify('error', exportError instanceof Error && exportError.message.trim() ? exportError.message : 'DATEV-Export fehlgeschlagen');
    } finally {
      setIsDatevExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      {!isError && report && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(13.25rem,100%),1fr))] gap-3">
          <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
            <Metric marker="tick" label="Einnahmen" tone="success" value={formatCurrency(report.summary.incomeTotal)} />
          </div>
          <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
            <Metric marker="tick" label="Ausgaben" tone="error" value={formatCurrency(report.summary.expenseTotal)} />
          </div>
          <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
            <Metric marker="tick" label="Überschuss" value={formatCurrency(report.summary.surplus)} />
          </div>
          <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
            <Metric marker="tick" label="Unklassifiziert" tone={report.unclassifiedCount > 0 ? 'warning' : 'neutral'} value={report.unclassifiedCount} />
          </div>
        </div>
      )}
      <section aria-labelledby="eur-report-title">
        <Card padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-3">
            <h2 id="eur-report-title" className="mr-auto text-section">Anlage EÜR {taxYear}</h2>
            <Select value={taxYear} aria-label="Steuerjahr" onChange={(e) => setTaxYear(Number(e.target.value))}>
              {yearOptions.map((year) => <option key={year} value={year}>{year > LATEST_SUPPORTED_EUR_TAX_YEAR ? `${year} (vorläufig)` : year}</option>)}
            </Select>
            <Button variant="secondary" onClick={() => void exportCsv()}>
              <Download size={16} aria-hidden="true" />
              CSV exportieren
            </Button>
            {(
              <Button variant="secondary" onClick={() => void exportPdf()} loading={isPdfExporting}>
                <Download size={16} aria-hidden="true" />
                PDF exportieren
              </Button>
            )}
            <span className="ml-2 text-caption text-muted" aria-hidden="true">DATEV-Zeitraum</span>
            <Select value={datevPeriod} aria-label="DATEV-Zeitraum" onChange={(e) => setDatevPeriod(e.target.value)}>
              <option value="year">Jahr {taxYear}</option>
              <optgroup label="Quartal">
                {[1, 2, 3, 4].map((quarter) => <option key={quarter} value={`q${quarter}`}>{quarter}. Quartal</option>)}
              </optgroup>
              <optgroup label="Monat">
                {MONTHS.map((month, index) => <option key={month} value={`m${index + 1}`}>{month}</option>)}
              </optgroup>
            </Select>
            <Button variant="secondary" onClick={() => void exportDatev()} loading={isDatevExporting}>
              <Download size={16} aria-hidden="true" />
              DATEV-Export
            </Button>
          </div>
          {report?.catalog?.provisional && (
            <p role="status" className="border-b border-border bg-warning-bg px-3.5 py-3 text-control text-foreground">
              Für {taxYear} ist noch keine Anlage EÜR veröffentlicht. Die Werte sind vorläufig mit der neuesten veröffentlichten Anlage berechnet.
            </p>
          )}
          {report?.unclassified && report.unclassified.incomeCount + report.unclassified.expenseCount > 0 && (
            <p role="status" aria-label="Fehlende Zahlungen" className="border-b border-border bg-warning-bg px-3.5 py-3 text-control text-foreground">
              Noch nicht zugeordnet und deshalb nicht in der EÜR:{' '}
              {report.unclassified.incomeCount > 0 && <>{report.unclassified.incomeCount} {report.unclassified.incomeCount === 1 ? 'Einnahme' : 'Einnahmen'} über {formatCurrency(report.unclassified.incomeAmount)}</>}
              {report.unclassified.incomeCount > 0 && report.unclassified.expenseCount > 0 && ', '}
              {report.unclassified.expenseCount > 0 && <>{report.unclassified.expenseCount} {report.unclassified.expenseCount === 1 ? 'Ausgabe' : 'Ausgaben'} über {formatCurrency(report.unclassified.expenseAmount)}</>}
              . Bitte unter Buchen zuordnen.
            </p>
          )}
          {datevResult && datevResult.errors.length > 0 && (
            <div role="status" aria-label="Nicht exportierte Posten" className="border-b border-border bg-warning-bg px-3.5 py-3">
              <p className="text-label text-foreground">
                {datevResult.errors.length === 1 ? '1 Posten ist' : `${datevResult.errors.length} Posten sind`} nicht in {datevResult.fileName}
              </p>
              <ul className="mt-1.5 flex flex-col gap-1 text-caption text-foreground-secondary">
                {datevResult.errors.map((rowError) => (
                  <li key={`${rowError.sourceType}:${rowError.sourceId}`}>
                    <span className="tabular-nums">{new Date(`${rowError.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                    {' · '}{rowError.counterparty || EMPTY_VALUE}{' · '}
                    <span className="tabular-nums">{formatCurrency(rowError.amount)}</span>
                    {': '}{rowError.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isError ? (
            <ErrorState
              title="Report konnte nicht geladen werden"
              description={error instanceof Error && error.message.trim() ? error.message : 'Unbekannter Fehler beim Laden.'}
              onRetry={() => void refetch()}
            />
          ) : isLoading ? (
            <div className="flex flex-col items-center justify-center py-10">
              <Spinner size="md" />
              <p className="mt-3 text-control text-muted">Report wird geladen …</p>
            </div>
          ) : !report ? (
            <EmptyState
              title="Für dieses Steuerjahr liegt noch kein Report vor"
              description="Sobald Buchungen importiert oder Rechnungen gestellt sind, entsteht hier die Auswertung."
            />
          ) : (
            <>
            <div className="flex items-center justify-end border-b border-border px-3.5 py-2">
              <label className="flex items-center gap-2 text-caption text-muted">
                <input type="checkbox" checked={showEmptyRows} onChange={(event) => setShowEmptyRows(event.target.checked)} />
                Auch Zeilen ohne Betrag zeigen
              </label>
            </div>
            <Table aria-label="EÜR-Report" bare>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Kz</TableHead>
                  <TableHead>Bezeichnung</TableHead>
                  <TableHead numeric>Betrag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} muted className="h-20 text-center">Noch keine Positionen in diesem Steuerjahr.</TableCell>
                  </TableRow>
                ) : null}
                {visibleRows.map((row) => (
                  <TableRow key={row.lineId}>
                    <TableCell muted className="font-mono">{row.kennziffer ?? EMPTY_VALUE}</TableCell>
                    <TableCell>{row.label}</TableCell>
                    <TableCell numeric className={`font-medium ${row.kind === 'income' ? 'text-success-text' : row.kind === 'expense' ? 'text-error-text' : ''}`}>
                      {formatCurrency(row.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </>
          )}
        </Card>
      </section>
    </div>
  );
};
