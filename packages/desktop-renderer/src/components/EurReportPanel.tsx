import React from 'react';
import {
  Button, EMPTY_VALUE, EmptyState, ErrorState, Metric, Select,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useActionFeedback,
} from '@billme/ui';
import { LATEST_SUPPORTED_EUR_TAX_YEAR, SUPPORTED_EUR_TAX_YEARS } from '@billme/accounting-shared';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { getRendererRuntime, ipc } from '../runtime-api';
import { Spinner } from '@billme/desktop-ui/components/Spinner';

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

/** Anlage EÜR for one tax year: totals, lines by Kennziffer, CSV and PDF export. */
export const EurReportPanel: React.FC = () => {
  const isWebShell = getRendererRuntime().shell === 'web';
  const [taxYear, setTaxYear] = React.useState<number>(LATEST_SUPPORTED_EUR_TAX_YEAR);
  const [isPdfExporting, setIsPdfExporting] = React.useState(false);
  const { notify } = useActionFeedback('eur-report');
  const { data: report, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['eur', 'report', taxYear],
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });

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

  return (
    <section aria-labelledby="eur-report-title" className="rounded-panel bg-surface p-5 shadow-xs">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 id="eur-report-title" className="mr-auto text-section">Anlage EÜR {taxYear}</h2>
        <Select value={taxYear} aria-label="Steuerjahr" onChange={(e) => setTaxYear(Number(e.target.value))}>
          {SUPPORTED_EUR_TAX_YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
        </Select>
        <Button variant="secondary" onClick={() => void exportCsv()}>
          <Download size={16} aria-hidden="true" />
          CSV exportieren
        </Button>
        {!isWebShell && (
          <Button onClick={() => void exportPdf()} loading={isPdfExporting}>
            <Download size={16} aria-hidden="true" />
            PDF exportieren
          </Button>
        )}
      </div>
      {isError ? (
        <ErrorState
          title="Report konnte nicht geladen werden"
          description={error instanceof Error && error.message.trim() ? error.message : 'Unbekannter Fehler beim Laden.'}
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Spinner size="md" />
          <p className="mt-3 text-sm text-muted">Report wird geladen …</p>
        </div>
      ) : !report ? (
        <EmptyState
          title="Für dieses Steuerjahr liegt noch kein Report vor"
          description="Sobald Buchungen importiert oder Rechnungen gestellt sind, entsteht hier die Auswertung."
          className="border-0 bg-transparent"
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 border-b border-border pb-4 md:grid-cols-4">
            <Metric label="Einnahmen" tone="success" value={formatCurrency(report.summary.incomeTotal)} />
            <Metric label="Ausgaben" tone="error" value={formatCurrency(report.summary.expenseTotal)} />
            <Metric label="Überschuss" value={formatCurrency(report.summary.surplus)} />
            <Metric label="Unklassifiziert" tone={report.unclassifiedCount > 0 ? 'warning' : 'neutral'} value={report.unclassifiedCount} />
          </div>
          <Table aria-label="EÜR-Report" density="compact" bare>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Kz</TableHead>
                <TableHead>Bezeichnung</TableHead>
                <TableHead numeric>Betrag</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} muted className="h-20 text-center">Noch keine Positionen in diesem Steuerjahr.</TableCell>
                </TableRow>
              ) : null}
              {report.rows.map((row) => (
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
    </section>
  );
};
