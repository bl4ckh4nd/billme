import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Card, CardHeader, IconButton, Input, Select } from '@billme/ui';
import AccountCombobox from './AccountCombobox';
import { PRIVATE_ACCOUNTS } from '../domain/bookingTemplates';
import { localToday } from '../domain/reportDates';
import type { Account } from '../types';
import type { ManualJournalEntryInput, ProAccountingDataAdapter } from '../services/accountingDataAdapter';

void React;

type Side = 'Soll' | 'Haben';
type TaxKey = '' | 'DE_STD_19' | 'DE_STD_7';
type Line = { key: string; accountNumber: string; accountName: string; side: Side; amount: string; taxCaseKey: TaxKey };

const LINE_GRID = 'grid grid-cols-[82px_minmax(0,1.4fr)_minmax(0,0.8fr)_112px_32px] items-center gap-x-2';
const newLine = (side: Side, accountNumber = '', accountName = ''): Line => ({ key: crypto.randomUUID(), accountNumber, accountName, side, amount: '', taxCaseKey: '' });
const toCents = (value: string): number | null => {
  const normalized = value.includes(',') ? value.replace(/\./g, '').replace(',', '.') : value;
  const number = Number(normalized.trim());
  if (!normalized.trim() || !Number.isFinite(number) || number <= 0) return null;
  const cents = Math.round(number * 100);
  return Math.abs(number * 100 - cents) < 1e-6 ? cents : null;
};
const euro = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const friendlyError = (message: string): string => {
  if (/POSTING_DATE_IN_CLOSED_PERIOD/.test(message)) return 'Der Monat ist festgeschrieben. Korrekturen bitte in einem offenen Monat buchen.';
  if (/SOFT_LOCK_OVERRIDE_REQUIRED/.test(message)) return 'Der Monat ist vorläufig gesperrt. Erst entsperren oder in einem offenen Monat buchen.';
  return message.replace(/^[A-Z_]+(:[^ ]*)?:?\s*/, '') || message;
};

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  accounts: Account[];
  chart: 'SKR03' | 'SKR04';
  canMutate: boolean;
  /** A GmbH/UG has no Privatkonten (Gesellschaftervorgänge go through their own workflow). */
  corporation?: boolean;
  onPosted?: (entryId: string) => void;
};

/** Freie Buchung (Buchungssatz): Beleg, Text, Soll- und Haben-Zeilen; posted directly, with a reason. */
export default function ManualEntryPanel({ dataAdapter, accounts, chart, canMutate, corporation = false, onPosted }: Props) {
  const [documentDate, setDocumentDate] = useState(localToday());
  const [reference, setReference] = useState('');
  const [bookingText, setBookingText] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [newLine('Soll'), newLine('Haben')]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string; entryId?: string } | null>(null);

  if (!dataAdapter?.postManualJournalEntry) return null;
  const nameOf = (number: string) => accounts.find((account) => account.number === number)?.name ?? '';
  const privat = PRIVATE_ACCOUNTS[chart];
  const update = (key: string, patch: Partial<Line>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const preset = (kind: 'withdrawal' | 'contribution') => {
    setLines(kind === 'withdrawal'
      ? [newLine('Soll', privat.withdrawal, nameOf(privat.withdrawal)), newLine('Haben', privat.cash, nameOf(privat.cash))]
      : [newLine('Soll', privat.cash, nameOf(privat.cash)), newLine('Haben', privat.contribution, nameOf(privat.contribution))]);
    if (!bookingText.trim()) setBookingText(kind === 'withdrawal' ? 'Privatentnahme' : 'Privateinlage');
  };

  const amounts = lines.map((line) => toCents(line.amount));
  const debit = lines.reduce((sum, line, index) => sum + (line.side === 'Soll' ? amounts[index] ?? 0 : 0), 0);
  const credit = lines.reduce((sum, line, index) => sum + (line.side === 'Haben' ? amounts[index] ?? 0 : 0), 0);
  const problems = [
    !documentDate ? 'Belegdatum fehlt.' : null,
    !reference.trim() ? 'Belegnummer fehlt: ohne Beleg keine Buchung.' : null,
    !bookingText.trim() ? 'Buchungstext fehlt.' : null,
    lines.length < 2 ? 'Mindestens zwei Zeilen.' : null,
    lines.some((line) => !line.accountNumber) ? 'Jede Zeile braucht ein Konto.' : null,
    amounts.some((value) => value === null) ? 'Jede Zeile braucht einen Betrag größer 0 mit höchstens zwei Nachkommastellen.' : null,
    debit !== credit ? `Soll und Haben unterscheiden sich um ${euro(Math.abs(debit - credit))}.` : null,
    !reason.trim() ? 'Begründung fehlt.' : null,
  ].filter((problem): problem is string => Boolean(problem));

  const submit = async () => {
    if (problems.length || busy || !canMutate) return;
    setBusy(true);
    setFeedback(null);
    const input: ManualJournalEntryInput = {
      reason: reason.trim(), documentDate, reference: reference.trim(), bookingText: bookingText.trim(), idempotencyKey,
      lines: lines.map((line, index) => ({
        accountNumber: line.accountNumber,
        debitAmount: line.side === 'Soll' ? amounts[index]! / 100 : 0,
        creditAmount: line.side === 'Haben' ? amounts[index]! / 100 : 0,
        ...(line.taxCaseKey ? { taxCaseKey: line.taxCaseKey } : {}),
      })),
    };
    try {
      const entry = await dataAdapter.postManualJournalEntry!(input);
      setFeedback({ kind: 'success', text: `Buchung Nr. ${entry.entryNumber} gebucht.`, entryId: entry.id });
      setReference('');
      setBookingText('');
      setReason('');
      setLines([newLine('Soll'), newLine('Haben')]);
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      setFeedback({ kind: 'error', text: friendlyError(error instanceof Error ? error.message : 'Die Buchung wurde nicht gespeichert.') });
    } finally {
      setBusy(false);
    }
  };

  const disabled = !canMutate || busy;
  return (
    <section aria-labelledby="manual-entry-heading" data-testid="manual-entry-panel">
      <Card padding="none">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title={<span id="manual-entry-heading">Neue Buchung (Buchungssatz)</span>}
          subtitle="Für Vorgänge ohne Bankzeile: Umbuchung, Korrektur, Barentnahme. Gebucht wird nur mit Beleg."
          actions={corporation ? undefined : (
            <span className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => preset('withdrawal')}>Privatentnahme bar</Button>
              <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => preset('contribution')}>Privateinlage bar</Button>
            </span>
          )}
        />
        <div className="flex flex-col gap-3 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input label="Belegdatum" aria-label="Belegdatum" type="date" required fullWidth value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} disabled={disabled} />
            <Input label="Belegnummer" aria-label="Belegnummer" required fullWidth maxLength={36} value={reference} onChange={(event) => setReference(event.target.value)} disabled={disabled} placeholder="z. B. KB-2026-031" />
            <div className="lg:col-span-2">
              <Input label="Buchungstext" aria-label="Buchungstext" required fullWidth maxLength={60} value={bookingText} onChange={(event) => setBookingText(event.target.value)} disabled={disabled} />
            </div>
          </div>

          <div>
            <div className={`${LINE_GRID} pb-1.5 text-eyebrow uppercase text-muted`}>
              <div>S/H</div>
              <div>Konto</div>
              <div>Steuer</div>
              <div className="text-right">Betrag</div>
              <div><span className="sr-only">Zeile entfernen</span></div>
            </div>
            <div className="divide-y divide-border" data-testid="manual-entry-lines">
              {lines.map((line, index) => (
                <div key={line.key} className={`${LINE_GRID} py-1.5`}>
                  <Select aria-label={`Seite Zeile ${index + 1}`} value={line.side} disabled={disabled} onChange={(event) => update(line.key, { side: event.target.value as Side })}>
                    <option value="Soll">Soll</option>
                    <option value="Haben">Haben</option>
                  </Select>
                  <AccountCombobox
                    accounts={accounts}
                    valueAccountId={line.accountNumber}
                    valueAccountName={line.accountName}
                    disabled={disabled}
                    onSelect={(account) => update(line.key, { accountNumber: account.number, accountName: account.name })}
                  />
                  <Select aria-label={`Steuerschlüssel Zeile ${index + 1}`} value={line.taxCaseKey} disabled={disabled} onChange={(event) => update(line.key, { taxCaseKey: event.target.value as TaxKey })}>
                    <option value="">ohne</option>
                    <option value="DE_STD_19">19 % (brutto)</option>
                    <option value="DE_STD_7">7 % (brutto)</option>
                  </Select>
                  <Input aria-label={`Betrag Zeile ${index + 1}`} inputMode="decimal" className="text-right tabular-nums" value={line.amount} disabled={disabled} onChange={(event) => update(line.key, { amount: event.target.value })} placeholder="0,00" />
                  <IconButton aria-label={`Zeile ${index + 1} entfernen`} variant="ghost" size="sm" disabled={disabled || lines.length <= 2} onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </IconButton>
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setLines((current) => [...current, newLine(debit > credit ? 'Haben' : 'Soll')])}>
                <Plus size={14} aria-hidden="true" /> Zeile hinzufügen
              </Button>
              <span className="text-caption tabular-nums text-muted">Soll {euro(debit)} · Haben {euro(credit)}</span>
            </div>
            <p className="mt-1 text-caption text-muted">Mit Steuerschlüssel ist der Betrag brutto; die Vorsteuer (Soll) bzw. Umsatzsteuer (Haben) bucht das Programm als eigene Zeile.</p>
          </div>

          <Input label="Begründung (Pflicht)" aria-label="Begründung" required fullWidth value={reason} onChange={(event) => setReason(event.target.value)} disabled={disabled} placeholder="Warum wird diese Buchung vorgenommen?" />
          {problems.length && (reference || bookingText || lines.some((line) => line.amount)) ? (
            <ul className="list-disc space-y-0.5 pl-4 text-caption text-muted" data-testid="manual-entry-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-3.5 py-3">
          {feedback ? (
            <p data-testid="manual-entry-feedback" className={`min-w-0 flex-1 text-control ${feedback.kind === 'error' ? 'text-error-text' : 'text-success-text'}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>
              {feedback.text}
              {feedback.entryId && onPosted ? <> <button type="button" className="underline" onClick={() => onPosted(feedback.entryId!)}>Buchung ansehen</button></> : null}
            </p>
          ) : null}
          <Button type="button" variant="dark" onClick={() => void submit()} disabled={disabled || problems.length > 0} aria-busy={busy}>{busy ? 'Buchung läuft…' : 'Verbindlich buchen'}</Button>
        </div>
      </Card>
    </section>
  );
}
