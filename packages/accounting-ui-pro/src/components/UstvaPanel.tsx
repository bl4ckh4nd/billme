import React, { useEffect, useState } from 'react';
import { Button, Card, CardHeader, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@billme/ui';
import type { UstvaComputation } from '@billme/accounting-shared';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';

void React;

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const pad = (value: number) => String(value).padStart(2, '0');
type Span = 'month' | 'quarter' | 'year';

/** First and last day of a month, a quarter or a year as local calendar dates. */
export const ustvaRange = (span: Span, month: string): { from: string; to: string } => {
  const [year, monthNo] = month.split('-').map(Number) as [number, number];
  const first = span === 'year' ? 1 : span === 'quarter' ? Math.floor((monthNo - 1) / 3) * 3 + 1 : monthNo;
  const last = span === 'year' ? 12 : span === 'quarter' ? first + 2 : monthNo;
  return { from: `${year}-${pad(first)}-01`, to: `${year}-${pad(last)}-${pad(new Date(Date.UTC(year, last, 0)).getUTCDate())}` };
};

const download = (content: string, fileName: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};
const csvCell = (value: string) => /[;"\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const csvAmount = (value: number) => value.toFixed(2).replace('.', ',');

/**
 * UStVA from the ledger: the Kennzahlen of the form for a month, quarter or year, each with the journal lines
 * behind it. Looking at it locks nothing; it is a preparation, not a transmission to ELSTER.
 */
export default function UstvaPanel({ dataAdapter, initialMonth, onOpenEntry }: { dataAdapter?: ProAccountingDataAdapter; initialMonth: string; onOpenEntry?: (entryId: string) => void }) {
  const [span, setSpan] = useState<Span>('month');
  const [month, setMonth] = useState(initialMonth);
  const [view, setView] = useState<UstvaComputation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const range = valid ? ustvaRange(span, month) : null;
  const from = range?.from;
  const to = range?.to;

  useEffect(() => {
    let current = true;
    if (!dataAdapter?.getVatSummary || !from || !to) return;
    setView(null);
    setOpen(null);
    dataAdapter.getVatSummary({ from, to })
      .then((summary) => { if (current) { setView(summary.kennzahlen ?? null); setError(summary.kennzahlen ? null : 'Kennzahlen sind nicht verfügbar.'); } })
      .catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message : 'UStVA konnte nicht geladen werden.'); });
    return () => { current = false; };
  }, [dataAdapter, from, to]);

  if (!dataAdapter?.getVatSummary) return null;
  const fileStem = range ? `ustva-${range.from}-${range.to}` : 'ustva';
  const exportCsv = () => {
    if (!view || !range) return;
    const rows = view.rows.map((row) => [row.kennziffer, csvCell(row.label), csvAmount(row.netAmount), row.taxKennziffer ?? '', csvAmount(row.taxAmount)].join(';'));
    download(`Zeitraum;${range.from} bis ${range.to}\nKennzahl;Bezeichnung;Bemessungsgrundlage;Steuer-Kennzahl;Steuer\n${rows.join('\n')}\n`, `${fileStem}.csv`, 'text/csv;charset=utf-8');
  };
  const exportJson = () => {
    if (!view || !range) return;
    download(JSON.stringify({ from: range.from, to: range.to, submissionReady: false, ...view }, null, 2), `${fileStem}.json`, 'application/json');
  };

  return (
    <section aria-labelledby="ustva-heading" data-testid="ustva-panel">
      <Card padding="none" className="overflow-hidden">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title={<span id="ustva-heading">Umsatzsteuer-Voranmeldung (Kennzahlen)</span>}
          subtitle="Aus dem Hauptbuch berechnet. Vorbereitung, keine Übermittlung an ELSTER. Das Ansehen sperrt keinen Monat."
        />
        <div className="flex flex-wrap items-end gap-3 px-3.5 py-3">
          <Select label="Zeitraum" aria-label="UStVA-Zeitraum" value={span} onChange={(event) => setSpan(event.target.value as Span)}>
            <option value="month">Monat</option>
            <option value="quarter">Quartal</option>
            <option value="year">Jahr</option>
          </Select>
          <Input label={span === 'month' ? 'Monat' : span === 'quarter' ? 'Monat im Quartal' : 'Monat im Jahr'} aria-label="UStVA-Monat" type="month" value={month} error={valid ? undefined : 'Zeitraum muss YYYY-MM sein.'} onChange={(event) => setMonth(event.target.value)} />
          {range ? <span className="text-caption tabular-nums text-muted">{range.from} bis {range.to}</span> : null}
          <span className="flex-1" />
          <Button type="button" size="sm" variant="secondary" disabled={!view} onClick={exportCsv}>CSV</Button>
          <Button type="button" size="sm" variant="secondary" disabled={!view} onClick={exportJson}>JSON</Button>
        </div>
        {error ? <p role="alert" className="px-3.5 pb-3 text-control text-error-text">{error}</p>
          : !view ? <p role="status" className="px-3.5 pb-3 text-control text-muted">UStVA wird berechnet…</p>
          : view.rows.length === 0 ? <p className="px-3.5 pb-3 text-control text-muted">Keine Umsätze oder Vorsteuer in diesem Zeitraum.</p>
          : (
            <>
              {view.issues.length ? <ul role="alert" className="mx-3.5 mb-3 list-disc rounded-control border border-warning-border bg-warning-bg py-2 pl-7 pr-3 text-control text-warning-text">{view.issues.map((issue) => <li key={`${issue.code}:${issue.entryId ?? ''}:${issue.taxCaseKey ?? ''}`}>{issue.message}</li>)}</ul> : null}
              <Table aria-label="UStVA-Kennzahlen">
                <TableHeader>
                  <TableRow>
                    <TableHead>Kz</TableHead>
                    <TableHead>Bezeichnung</TableHead>
                    <TableHead className="text-right">Bemessungsgrundlage</TableHead>
                    <TableHead className="text-right">Steuer</TableHead>
                    <TableHead><span className="sr-only">Buchungen</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.rows.map((row) => {
                    const key = `${row.kennziffer}:${row.direction}`;
                    const sources = view.sources.filter((source) => source.kennziffer === row.kennziffer && source.direction === row.direction);
                    const total = row.direction === 'total';
                    return (
                      <React.Fragment key={key}>
                        <TableRow data-kennziffer={row.kennziffer} className={total ? 'font-semibold' : undefined}>
                          <TableCell className="tabular-nums">{row.kennziffer}{row.taxKennziffer ? ` / ${row.taxKennziffer}` : ''}</TableCell>
                          <TableCell>{row.label}{row.direction === 'input' ? ' (Vorsteuer)' : row.direction === 'information' ? ' (ohne Steuer)' : ''}</TableCell>
                          <TableCell className="text-right tabular-nums">{total ? '' : euro(row.netAmount)}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.direction === 'information' ? '' : euro(row.taxAmount)}</TableCell>
                          <TableCell className="text-right">{sources.length ? <Button type="button" size="sm" variant="ghost" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>{sources.length} Buchung{sources.length === 1 ? '' : 'en'}</Button> : null}</TableCell>
                        </TableRow>
                        {open === key ? sources.map((source, index) => (
                          <TableRow key={`${key}:${index}`} className="bg-surface-muted">
                            <TableCell className="tabular-nums text-muted">{source.postingDate.split('-').reverse().join('.')}</TableCell>
                            <TableCell className="text-muted">{source.entryNumber ? `Buchung ${source.entryNumber}` : 'Buchung'}{source.reference ? ` · ${source.reference}` : ''}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted">{euro(source.netAmount)}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted">{euro(source.taxAmount)}</TableCell>
                            <TableCell className="text-right">{source.entryId && onOpenEntry ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenEntry(source.entryId!)}>Journal öffnen</Button> : null}</TableCell>
                          </TableRow>
                        )) : null}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </>
          )}
      </Card>
    </section>
  );
}
