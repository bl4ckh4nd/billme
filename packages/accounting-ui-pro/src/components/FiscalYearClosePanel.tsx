import React, { useMemo, useState } from 'react';
import { Button, Card, CardHeader, ConfirmDialog, Input, Select } from '@billme/ui';
import { accountingErrorText, defaultResultAccount, fiscalYearForDate, fiscalYearRange } from '@billme/accounting-shared';
import { localToday } from '../domain/reportDates';
import type { Account } from '../types';
import type { BusinessReportingProfile } from '../domain/reportTypes';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';
import type { AccountingCommandInput, AccountingCommandPreview, AccountingSourcePostResult } from '../sourceRuns';

void React;

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  accounts: Account[];
  chart: 'SKR03' | 'SKR04';
  profile?: BusinessReportingProfile;
  canMutate: boolean;
  onPosted?: (entryId: string) => void;
};

type Step = { kind: 'fiscal_close' | 'carry_forward'; sourceId: string; date: string; preview?: AccountingCommandPreview; booked?: boolean };

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const germanDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * Jahresabschluss: the user picks the fiscal year; the server derives the closing entry (Erfolgskonten → result
 * account) and the Saldovortrag (Bestandskonten → next year) from the ledger, shows both as a preview and books
 * them only after a confirmation. The lines shown are the lines booked.
 */
export default function FiscalYearClosePanel({ dataAdapter, accounts, chart, profile, canMutate, onPosted }: Props) {
  const fiscalYearStart = profile?.fiscalYearStart ?? '01-01';
  const today = localToday();
  const currentYear = fiscalYearForDate(today, fiscalYearStart);
  const years = useMemo(() => Array.from({ length: 6 }, (_, index) => currentYear - index), [currentYear]);
  const [year, setYear] = useState(currentYear - 1);
  const [resultAccount, setResultAccount] = useState(() => defaultResultAccount(chart, profile?.legalForm));
  const [reason, setReason] = useState('');
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [overrideLock, setOverrideLock] = useState(false);

  if (!dataAdapter?.postAccountingCommand) return null;
  const range = fiscalYearRange(year, fiscalYearStart);
  const next = fiscalYearRange(year + 1, fiscalYearStart);
  const yearNotOver = range.end >= today;
  const nameOf = (number: string) => accounts.find((account) => account.number === number)?.name ?? '';

  const command = (step: Step, preview: boolean): AccountingCommandInput => {
    const close = step.kind === 'fiscal_close';
    const fiscalYear = close ? year : year + 1;
    return {
      kind: step.kind,
      source: { sourceType: step.kind, sourceId: step.sourceId, sourceRevision: '1', effectiveDate: step.date, postingDate: step.date, period: step.date.slice(0, 7), fiscalYear, currency: 'EUR', bookingText: close ? `Jahresabschluss ${range.label}` : `Saldovortrag ${next.label}`, reference: step.sourceId, lines: [] },
      domainFacts: {
        sourceId: step.sourceId, sourceRevision: '1', fiscalYear, period: step.date.slice(0, 7), currency: 'EUR', fiscalYearStart,
        ...(close ? { closingDate: step.date } : { effectiveDate: step.date }),
        retainedEarningsAccount: resultAccount.trim(),
        ...(preview ? { preview: true } : {}),
      },
      // A preview books nothing; the audit reason is only required for the booking.
      reason: reason.trim() || (preview ? 'Vorschau Jahresabschluss' : ''),
      ...(overrideLock ? { softLockOverride: true, overrideReason: reason.trim() } : {}),
    };
  };
  const planned = (): Step[] => [
    { kind: 'fiscal_close', sourceId: `JA-${range.label}`, date: range.end },
    { kind: 'carry_forward', sourceId: `EB-${next.label}`, date: next.start },
  ];
  const errorOf = (error: unknown) => accountingErrorText(error instanceof Error ? error.message : String(error));

  const loadPreview = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const out: Step[] = [];
      for (const step of planned()) {
        const result: AccountingSourcePostResult = await dataAdapter.postAccountingCommand!(command(step, true));
        out.push(result.status === 'duplicate' ? { ...step, booked: true } : { ...step, preview: result.command as AccountingCommandPreview });
      }
      setSteps(out);
    } catch (error) {
      setSteps(null);
      setMessage({ kind: 'error', text: errorOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const book = async () => {
    if (!steps) return;
    setConfirming(false);
    setBusy(true);
    setMessage(null);
    try {
      let firstEntry: string | undefined;
      for (const step of steps.filter((candidate) => !candidate.booked && candidate.preview?.lines.length)) {
        const result = await dataAdapter.postAccountingCommand!(command(step, false));
        if (result.status === 'rejected' || result.errors.length) throw new Error(result.errors.map((error) => error.message).join(' ') || 'Buchung abgelehnt.');
        firstEntry ??= result.sourceRun?.journalEntryId;
      }
      setSteps(null);
      setMessage({ kind: 'success', text: `Geschäftsjahr ${range.label} abgeschlossen, Saldovortrag zum ${germanDate(next.start)} gebucht. Die Monate ${range.label} sind jetzt vorläufig gesperrt.` });
      if (firstEntry) onPosted?.(firstEntry);
    } catch (error) {
      setMessage({ kind: 'error', text: errorOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setSteps(null); setMessage(null); };
  const closeStep = steps?.find((step) => step.kind === 'fiscal_close');
  const netResult = closeStep?.preview?.netResult;
  const bookable = Boolean(steps?.some((step) => !step.booked && step.preview?.lines.length));
  const softLocked = message?.kind === 'error' && /vorläufig gesperrt/.test(message.text);

  return (
    <section aria-labelledby="fiscal-close-heading">
      <Card padding="none">
        <CardHeader className="border-b border-border px-3.5 py-3" title={<span id="fiscal-close-heading">Jahresabschluss und Saldovortrag</span>} subtitle="Schließt die Erfolgskonten eines Geschäftsjahres in das Ergebniskonto ab und trägt die Bestandskonten ins neue Jahr vor. Die Buchungen entstehen aus dem Hauptbuch." />
        <div className="flex flex-col gap-3 p-3.5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Select label="Geschäftsjahr" aria-label="Geschäftsjahr" value={String(year)} onChange={(event) => { setYear(Number(event.target.value)); reset(); }} disabled={busy}>
              {years.map((option) => <option key={option} value={option}>{fiscalYearRange(option, fiscalYearStart).label}</option>)}
            </Select>
            <Input label="Ergebniskonto" aria-label="Ergebniskonto" value={resultAccount} onChange={(event) => { setResultAccount(event.target.value); reset(); }} disabled={busy} hint={nameOf(resultAccount.trim()) || 'Gewinnvortrag (GmbH/UG) bzw. Kapitalkonto'} />
            <Input label="Audit-Grund (Pflicht)" aria-label="Audit-Grund Jahresabschluss" value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} placeholder="z. B. Jahresabschluss erstellt" />
          </div>
          {yearNotOver ? <p className="text-caption text-warning-text" role="status">Das Geschäftsjahr {range.label} endet erst am {germanDate(range.end)}. Die Vorschau ist möglich, gebucht wird der Abschluss erst danach.</p> : null}
          {steps ? (
            <div className="flex flex-col gap-3" data-testid="fiscal-close-preview">
              {steps.map((step) => (
                <div key={step.kind} className="rounded-control border border-border">
                  <p className="border-b border-border px-3 py-2 text-label text-foreground">{step.kind === 'fiscal_close' ? `Abschlussbuchung zum ${germanDate(step.date)}` : `Saldovortrag zum ${germanDate(step.date)}`}</p>
                  {step.booked ? <p className="px-3 py-2 text-control text-muted">Bereits gebucht.</p> : !step.preview?.lines.length ? <p className="px-3 py-2 text-control text-muted">Keine Salden, nichts zu buchen.</p> : (
                    <table className="w-full text-control">
                      <thead><tr className="text-left text-caption text-muted"><th className="px-3 py-1.5 font-medium">Konto</th><th className="px-3 py-1.5 text-right font-medium">Soll</th><th className="px-3 py-1.5 text-right font-medium">Haben</th></tr></thead>
                      <tbody>
                        {step.preview.lines.map((line, index) => (
                          <tr key={`${line.accountNumber}-${index}`} className="border-t border-border">
                            <td className="px-3 py-1.5"><span className="tabular-nums">{line.accountNumber}</span> <span className="text-muted">{nameOf(line.accountNumber)}</span></td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{line.debitAmount ? euro(line.debitAmount) : ''}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{line.creditAmount ? euro(line.creditAmount) : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
              {typeof netResult === 'number' ? <p className="text-control text-foreground" data-testid="fiscal-close-result">Jahresergebnis {range.label}: {netResult >= 0 ? 'Gewinn' : 'Verlust'} {euro(Math.abs(netResult))} auf Konto {resultAccount.trim()}</p> : null}
            </div>
          ) : null}
          {message ? <p className={`text-control ${message.kind === 'error' ? 'text-error-text' : 'text-success-text'}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
          {softLocked ? (
            <label className="flex items-center gap-2 text-control text-foreground">
              <input type="checkbox" checked={overrideLock} onChange={(event) => setOverrideLock(event.target.checked)} />
              Trotz vorläufiger Sperre buchen (der Audit-Grund wird protokolliert)
            </label>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-3.5 py-3">
          <Button type="button" variant="secondary" onClick={() => void loadPreview()} disabled={busy || !resultAccount.trim()} aria-busy={busy}>Vorschau berechnen</Button>
          <Button type="button" variant="dark" onClick={() => setConfirming(true)} disabled={busy || !canMutate || !bookable || yearNotOver || !reason.trim()}>Abschluss buchen</Button>
        </div>
      </Card>
      <ConfirmDialog
        open={confirming}
        title={`Geschäftsjahr ${range.label} abschließen?`}
        description={`Gebucht werden die gezeigten Zeilen: die Abschlussbuchung zum ${germanDate(range.end)} und der Saldovortrag zum ${germanDate(next.start)}. Danach sind alle Monate von ${range.label} vorläufig gesperrt; spätere Buchungen in das Jahr brauchen eine Begründung.`}
        confirmLabel="Abschluss buchen"
        cancelLabel="Abbrechen"
        onConfirm={() => void book()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
