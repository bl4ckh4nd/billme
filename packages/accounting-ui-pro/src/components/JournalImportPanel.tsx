import React, { useRef, useState } from 'react';
import { Badge, Button, Card, CardHeader, Checkbox, Input, Select } from '@billme/ui';
import type { JournalImportResult, ProAccountingDataAdapter } from '../services/accountingDataAdapter';

void React;

type Format = 'datev' | 'journal_csv';

const MAX_BYTES = 20 * 1024 * 1024;
const PREVIEW_ROWS = 50;
const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const date = (iso?: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '–');
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
/** A DATEV file starts with "EXTF" or "DTVF" (quoted), anything else is read as journal CSV. */
const detectFormat = (bytes: Uint8Array): Format => (/^﻿?"?(EXTF|DTVF)"?;/.test(new TextDecoder('latin1').decode(bytes.subarray(0, 16))) ? 'datev' : 'journal_csv');
const friendlyError = (message: string): string => message.replace(/^[A-Z_]+(:[^ ]*)?:?\s*/, '') || message;
const STATUS: Record<JournalImportResult['entries'][number]['status'], { tone: 'success' | 'neutral' | 'error'; label: string }> = {
  new: { tone: 'success', label: 'neu' },
  imported: { tone: 'neutral', label: 'schon importiert' },
  invalid: { tone: 'error', label: 'Fehler' },
};

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  canMutate: boolean;
  onImported?: () => void;
};

/**
 * Übernahme gebuchter Sätze aus einer anderen Buchhaltung: DATEV-Buchungsstapel (EXTF) oder Journal-CSV. First a
 * check of the whole file (accounts, periods, tax keys, duplicates), then one confirmed import of all new entries.
 */
export default function JournalImportPanel({ dataAdapter, canMutate, onImported }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [format, setFormat] = useState<Format>('datev');
  const [reason, setReason] = useState('');
  const [softLockOverride, setSoftLockOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [result, setResult] = useState<JournalImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  if (!dataAdapter?.importJournal) return null;
  const disabled = !canMutate || busy;

  const choose = async (picked: File | undefined) => {
    setResult(null);
    setFeedback(null);
    if (!picked) { setFile(null); return; }
    if (picked.size > MAX_BYTES) { setFile(null); setFeedback({ kind: 'error', text: 'Die Datei ist größer als 20 MB. Bitte in Jahresstapel teilen.' }); return; }
    const bytes = new Uint8Array(await picked.arrayBuffer());
    setFormat(detectFormat(bytes));
    setFile({ name: picked.name, base64: toBase64(bytes) });
  };

  const run = async (dryRun: boolean) => {
    if (!file || !reason.trim() || disabled) return;
    setBusy(true);
    setFeedback(null);
    try {
      const next = await dataAdapter.importJournal!({
        reason: reason.trim(), format, fileName: file.name, contentBase64: file.base64, dryRun,
        ...(softLockOverride && overrideReason.trim() ? { softLockOverride: true, overrideReason: overrideReason.trim() } : {}),
      });
      setResult(next);
      if (!dryRun && next.postedCount > 0) {
        setFeedback({ kind: 'success', text: `${next.postedCount} Buchung${next.postedCount === 1 ? '' : 'en'} importiert.` });
        onImported?.();
      } else if (!dryRun) {
        setFeedback({ kind: 'error', text: 'Nichts importiert: bitte die Hinweise unten prüfen.' });
      }
    } catch (error) {
      setFeedback({ kind: 'error', text: friendlyError(error instanceof Error ? error.message : 'Der Import ist fehlgeschlagen.') });
    } finally {
      setBusy(false);
    }
  };

  const blocking = result?.issues.filter((issue) => issue.blocking) ?? [];
  const notes = result?.issues.filter((issue) => !issue.blocking) ?? [];
  const softLocked = blocking.some((issue) => /vorläufig gesperrt/.test(issue.message));
  const checked = Boolean(result?.dryRun);
  const canImport = checked && !blocking.length && (result?.newCount ?? 0) > 0 && !disabled;

  return (
    <section aria-labelledby="journal-import-heading" data-testid="journal-import-panel">
      <Card padding="none">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title={<span id="journal-import-heading">Buchungen importieren (DATEV, Journal)</span>}
          subtitle="Übernahme aus einer anderen Buchhaltung: erst wird die ganze Datei geprüft, dann alle neuen Buchungen auf einmal gebucht oder keine."
        />
        <div className="flex flex-col gap-3 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <label className="min-w-0 text-caption font-medium text-foreground-secondary">
              Datei
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                aria-label="Importdatei"
                disabled={disabled}
                className="mt-1 block w-full text-control font-normal text-foreground file:mr-3 file:h-8.5 file:rounded-control file:border file:border-border-strong file:bg-surface file:px-3 file:text-label file:font-medium file:text-foreground"
                onChange={(event) => void choose(event.target.files?.[0])}
              />
            </label>
            <Select label="Format" aria-label="Format" fullWidth value={format} disabled={disabled} onChange={(event) => { setFormat(event.target.value as Format); setResult(null); }}>
              <option value="datev">DATEV-Buchungsstapel (EXTF)</option>
              <option value="journal_csv">Journal-CSV (eine Zeile je Buchungszeile)</option>
            </Select>
          </div>
          {format === 'journal_csv' ? (
            <p className="text-caption text-muted text-pretty" data-testid="journal-import-csv-hint">
              Spalten: <code>Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall</code> (optional <code>Land</code>, <code>USt-IdNr</code>, <code>Notiz</code>).
              Zeilen mit gleicher Buchung bilden einen Buchungssatz. Steuerfall z. B. <code>VSt19</code>, <code>USt7</code> oder <code>NON_EU_SERVICE_RC</code>: steht die Steuerzeile in der Buchung, ist die Zeile netto, sonst brutto.
            </p>
          ) : (
            <p className="text-caption text-muted text-pretty">
              BU-Schlüssel 2/3/8/9 (7 %/19 %), 40, 91/94 (§ 13b mit Sachverhalt L+L) und 18/19 (Erwerb) sowie Automatikkonten werden in Netto- und Steuerzeile aufgeteilt. Personenkonten landen auf den Sammelkonten.
            </p>
          )}
          <Input label="Begründung (Pflicht)" aria-label="Begründung des Imports" required fullWidth value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} placeholder="z. B. Übernahme der Buchhaltung 2025 aus dem bisherigen Programm" />
          {softLocked ? (
            <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end">
              <Checkbox label="Vorläufige Sperre übergehen" checked={softLockOverride} disabled={disabled} onChange={(event) => setSoftLockOverride(event.target.checked)} />
              <Input label="Begründung für das Übergehen" aria-label="Begründung für das Übergehen" fullWidth value={overrideReason} disabled={disabled || !softLockOverride} onChange={(event) => setOverrideReason(event.target.value)} />
            </div>
          ) : null}

          {result ? (
            <div className="flex flex-col gap-3" data-testid="journal-import-result">
              <dl className="grid gap-x-4 gap-y-1 text-caption sm:grid-cols-3 lg:grid-cols-6">
                <div><dt className="text-muted">Buchungen in der Datei</dt><dd className="tabular-nums">{result.entryCount}</dd></div>
                <div><dt className="text-muted">Neu</dt><dd className="tabular-nums" data-testid="journal-import-new">{result.newCount}</dd></div>
                <div><dt className="text-muted">Schon importiert</dt><dd className="tabular-nums">{result.importedCount}</dd></div>
                <div><dt className="text-muted">Fehlerhaft</dt><dd className="tabular-nums">{result.invalidCount}</dd></div>
                <div><dt className="text-muted">Zeitraum</dt><dd className="tabular-nums">{result.firstDate ? `${date(result.firstDate)} – ${date(result.lastDate)}` : '–'}</dd></div>
                <div><dt className="text-muted">Summe Soll (neu)</dt><dd className="tabular-nums">{euro(result.debitTotal)}</dd></div>
              </dl>
              {result.source.chart || result.source.label ? (
                <p className="text-caption text-muted">DATEV-Stapel {result.source.label ? `„${result.source.label}“ ` : ''}{result.source.chart ?? ''}{result.source.from ? `, ${date(result.source.from)} – ${date(result.source.to)}` : ''}{result.source.clientNumber ? `, Mandant ${result.source.clientNumber}` : ''}</p>
              ) : null}
              {result.missingAccounts.length ? (
                <p className="text-control text-error-text" role="alert">Fehlende Konten: {result.missingAccounts.join(', ')}. Bitte unter Kontenplan anlegen und erneut prüfen.</p>
              ) : null}
              {blocking.length ? (
                <ul className="list-disc space-y-0.5 pl-4 text-caption text-error-text" data-testid="journal-import-blocking">
                  {blocking.slice(0, 20).map((issue, index) => <li key={`${issue.row}-${index}`}>{issue.row ? `Zeile ${issue.row}: ` : ''}{issue.message}</li>)}
                  {blocking.length > 20 ? <li>… und {blocking.length - 20} weitere</li> : null}
                </ul>
              ) : null}
              {notes.length ? (
                <ul className="list-disc space-y-0.5 pl-4 text-caption text-muted" data-testid="journal-import-notes">
                  {notes.map((issue, index) => <li key={`${issue.row}-${index}`}>{issue.message}</li>)}
                </ul>
              ) : null}
              {result.entries.length ? (
                <div className="max-h-96 overflow-auto rounded-control border border-border">
                  <table className="w-full text-caption">
                    <thead className="sticky top-0 bg-surface text-left text-eyebrow uppercase text-muted">
                      <tr><th className="px-2 py-1.5">Datum</th><th className="px-2 py-1.5">Beleg</th><th className="px-2 py-1.5">Text</th><th className="px-2 py-1.5">Zeilen</th><th className="px-2 py-1.5">Status</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {result.entries.slice(0, PREVIEW_ROWS).map((entry) => (
                        <tr key={entry.key} className="align-top">
                          <td className="px-2 py-1.5 tabular-nums">{date(entry.postingDate)}</td>
                          <td className="px-2 py-1.5">{entry.reference}</td>
                          <td className="px-2 py-1.5">{entry.bookingText}</td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {entry.lines.map((line, index) => (
                              <div key={index}>{line.debitAmount > 0 ? 'S' : 'H'} {line.accountNumber}{line.accountName ? ` ${line.accountName}` : ''} {euro(line.debitAmount || line.creditAmount)}{line.taxCaseKey ? ` · ${line.taxCaseKey}` : ''}</div>
                            ))}
                          </td>
                          <td className="px-2 py-1.5"><Badge tone={STATUS[entry.status].tone}>{STATUS[entry.status].label}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {result.entryCount > PREVIEW_ROWS ? <p className="px-2 py-1.5 text-caption text-muted">Vorschau der ersten {PREVIEW_ROWS} von {result.entryCount} Buchungen{result.invalidCount ? ', fehlerhafte zuerst' : ''}.</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-3.5 py-3">
          {feedback ? (
            <p data-testid="journal-import-feedback" className={`min-w-0 flex-1 text-control ${feedback.kind === 'error' ? 'text-error-text' : 'text-success-text'}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>
          ) : null}
          <Button type="button" variant="secondary" onClick={() => void run(true)} disabled={disabled || !file || !reason.trim()} aria-busy={busy && !checked}>{busy && !result ? 'Prüfung läuft…' : 'Datei prüfen'}</Button>
          <Button type="button" variant="dark" onClick={() => void run(false)} disabled={!canImport} aria-busy={busy}>
            {busy && checked ? 'Import läuft…' : `${result?.dryRun ? result.newCount : 0} Buchungen verbindlich importieren`}
          </Button>
        </div>
      </Card>
    </section>
  );
}
