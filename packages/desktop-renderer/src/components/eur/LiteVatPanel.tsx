import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { eurTaxYearOptions } from '@billme/accounting-shared';
import { Badge, Button, Card, Checkbox, ErrorState, Input, Metric, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useActionFeedback } from '@billme/ui';
import { ipc } from '../../runtime-api';
import { useSetSettingsMutation, useSettingsQuery } from '../../hooks/useSettings';

export const vatMonthPeriod = (year: number, month: number) => ({ from: `${year}-${String(month + 1).padStart(2, '0')}-01`, to: `${year}-${String(month + 1).padStart(2, '0')}-${new Date(year, month + 1, 0).getDate()}` });
export const useLiteVatReport = (period: { from: string; to: string }, enabled = true) => useQuery({ queryKey: ['lite-vat', period], queryFn: () => ipc.vat.getReport(period), enabled });
const money = (amount: number) => (amount / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const germanDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE');

/** Dauerfristverlängerung (§ 46 UStDV) and the Sondervorauszahlung of the year: Kz 38/39 of the UStVA. */
const VatExtensionCard: React.FC<{ year: number }> = ({ year }) => {
  const settings = useSettingsQuery();
  const save = useSetSettingsMutation();
  const queryClient = useQueryClient();
  const { notify } = useActionFeedback('lite-vat-extension');
  const legal = settings.data?.legal;
  const stored = legal?.vatSpecialPrepayment?.year === year ? legal.vatSpecialPrepayment.amountCents : 0;
  const [typed, setAmount] = React.useState<string>();
  const amount = typed ?? (stored ? String(stored / 100) : '');
  if (!settings.data || !legal || legal.smallBusinessRule) return null;
  const persist = async (next: { vatPermanentExtension?: boolean; vatSpecialPrepayment?: { year: number; amountCents: number } }) => {
    try {
      await save.mutateAsync({ ...settings.data!, legal: { ...legal, ...next } });
      await queryClient.invalidateQueries({ queryKey: ['lite-vat'] });
      notify('success', 'Gespeichert');
    } catch (error) { notify('error', error instanceof Error ? error.message : 'Speichern fehlgeschlagen'); }
  };
  const cents = Math.round(Number(amount.trim().replace(',', '.') || '0') * 100);
  return <Card><h3 className="text-control font-semibold">Dauerfristverlängerung</h3>
    <p className="mt-2 text-control text-muted">Mit Dauerfristverlängerung ist jede Voranmeldung einen Monat später fällig. Monatszahler leisten dafür eine Sondervorauszahlung (1/11 der Vorjahreszahllast), die mit der Dezember-Voranmeldung verrechnet wird (Kz 39).</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <Checkbox label="Dauerfristverlängerung beantragt" checked={legal.vatPermanentExtension ?? false} disabled={save.isPending} onChange={(e) => void persist({ vatPermanentExtension: e.target.checked })} />
      {legal.vatPermanentExtension && <><Input label={`Sondervorauszahlung ${year} in EUR`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Button variant="secondary" disabled={save.isPending || !Number.isSafeInteger(cents) || cents < 0} onClick={() => void persist({ vatSpecialPrepayment: { year, amountCents: cents } })}>Speichern</Button></>}
    </div></Card>;
};

export const LiteVatPanel: React.FC = () => {
  const today = new Date();
  const years = eurTaxYearOptions(today);
  const [year, setYear] = React.useState(Math.max(2025, today.getFullYear()));
  const [periodKind, setPeriodKind] = React.useState('month');
  const [index, setIndex] = React.useState(today.getMonth());
  const period = periodKind === 'year' ? { from: `${year}-01-01`, to: `${year}-12-31` } : periodKind === 'quarter' ? { from: vatMonthPeriod(year, Math.floor(index / 3) * 3).from, to: vatMonthPeriod(year, Math.floor(index / 3) * 3 + 2).to } : vatMonthPeriod(year, index);
  const query = useLiteVatReport(period);
  const [exporting, setExporting] = React.useState(false);
  const { notify } = useActionFeedback('lite-vat');
  const download = async (format: 'csv' | 'pdf') => {
    setExporting(true);
    try {
      const file = await (format === 'pdf' ? ipc.vat.exportPdf(period) : ipc.vat.exportCsv(period));
      const bytes = Uint8Array.from(atob(file.contentBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
      const link = document.createElement('a'); link.href = url; link.download = file.fileName; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('success', `${format.toUpperCase()} heruntergeladen`);
    } catch (error) { notify('error', error instanceof Error ? error.message : 'Export fehlgeschlagen'); }
    finally { setExporting(false); }
  };
  const report = query.data;
  return <div className="flex flex-col gap-4">
    <Card><div className="flex flex-wrap items-end gap-3">
      <Select label="Steuerjahr" value={year} onChange={(e) => setYear(Number(e.target.value))}>{years.map((option) => <option key={option} value={option}>{option}</option>)}</Select>
      <Select label="Voranmeldungszeitraum" value={periodKind} onChange={(e) => setPeriodKind(e.target.value)}><option value="month">Monat</option><option value="quarter">Quartal</option><option value="year">Jahr</option></Select>
      {periodKind !== 'year' && <Select label={periodKind === 'quarter' ? 'Quartal' : 'Monat'} value={periodKind === 'quarter' ? Math.floor(index / 3) : index} onChange={(e) => setIndex(Number(e.target.value) * (periodKind === 'quarter' ? 3 : 1))}>{Array.from({ length: periodKind === 'quarter' ? 4 : 12 }, (_, i) => <option key={i} value={i}>{periodKind === 'quarter' ? `${i + 1}. Quartal` : new Date(year, i, 1).toLocaleDateString('de-DE', { month: 'long' })}</option>)}</Select>}
      <Button variant="secondary" disabled={!report || exporting} onClick={() => void download('csv')}>CSV herunterladen</Button><Button variant="secondary" disabled={!report || exporting} onClick={() => void download('pdf')}>PDF herunterladen</Button>
    </div><p className="mt-3 text-control text-muted">Vorbereitung aus erfassten Rechnungen, Zahlungen und geprüften Belegen. Keine direkte ELSTER-Übermittlung.</p></Card>
    {query.isError && <ErrorState title="Umsatzsteuer konnte nicht vorbereitet werden" description={query.error instanceof Error ? query.error.message : 'Daten nicht verfügbar.'} onRetry={() => void query.refetch()} />}
    {query.isLoading && <p role="status">Steuerdaten werden geladen …</p>}
    {report && <>
      <div className="flex flex-wrap items-center gap-3"><h2 className="text-section">Umsatzsteuer {report.from} bis {report.to}</h2><Badge tone={report.preparationComplete ? 'success' : 'warning'}>{report.preparationComplete ? 'Prüfung vollständig' : 'Prüfung offen'}</Badge><span className="text-control text-muted">{report.method === 'ist' ? 'Ist-Versteuerung nach Zahlung' : 'Soll-Versteuerung nach Leistung, einschließlich Anzahlungen'}</span></div>
      {!report.filingRequired && <Card><p className="text-control font-semibold">Als Kleinunternehmer (§ 19 UStG) gibst du für diesen Zeitraum keine Umsatzsteuer-Voranmeldung ab.</p><p className="mt-2 text-control text-muted">Nur besondere Steuerschulden, etwa nach § 13b oder aus einem innergemeinschaftlichen Erwerb, müssten angemeldet werden. Im gewählten Zeitraum gibt es keine.</p></Card>}
      {report.smallBusinessLimits && <Card><h3 className="text-control font-semibold">Grenzen für Kleinunternehmer</h3><p className="mt-2 text-control">Umsatz {report.smallBusinessLimits.previousYear}: {money(report.smallBusinessLimits.previousYearCents)} von {money(report.smallBusinessLimits.previousLimitCents)} · Umsatz {report.smallBusinessLimits.currentYear} bisher: {money(report.smallBusinessLimits.currentYearCents)} von {money(report.smallBusinessLimits.currentLimitCents)}</p><p className="mt-2 text-caption text-muted">Gezählt werden gestellte Rechnungen netto nach Rechnungsdatum. Wer im laufenden Jahr 100.000 € überschreitet, ist ab diesem Umsatz kein Kleinunternehmer mehr.</p></Card>}
      {report.filingRequired && <div className="grid gap-3 sm:grid-cols-3"><Card><Metric label="Umsatzsteuer" value={money(report.outputVatCents)} /></Card><Card><Metric label="Abziehbare Vorsteuer" value={money(report.inputVatCents)} /></Card><Card><Metric label={report.payableCents < 0 ? 'Voraussichtliche Erstattung' : 'Voraussichtliche Zahllast'} value={money(Math.abs(report.payableCents))} /></Card></div>}
      {report.filingRequired && (report.specialPrepaymentCents !== 0 || report.dueDate) && <Card>
        {report.specialPrepaymentCents !== 0 && <p className="text-control">Abzüglich Sondervorauszahlung (Kz 39): {money(report.specialPrepaymentCents)} · Verbleibender Betrag (Kz 83): {report.remainingCents < 0 ? `Erstattung ${money(Math.abs(report.remainingCents))}` : money(report.remainingCents)}</p>}
        {report.dueDate && <p className="mt-1 text-control">Abgabe und Zahlung fällig bis {germanDate(report.dueDate)}{report.permanentExtension ? ' (mit Dauerfristverlängerung)' : ''}. Fällt der Tag auf ein Wochenende oder einen Feiertag, gilt der nächste Werktag.</p>}
      </Card>}
      {report.smallBusiness && report.filingRequired && !report.issues.some((item) => item.code === 'KU_INVOICE_VAT_SHOWN') && <p className="text-control">Kleinunternehmer: eigene Ausgangsumsätze sind steuerfrei. Besondere Steuerschulden, etwa § 13b oder innergemeinschaftlicher Erwerb, werden gesondert berücksichtigt.</p>}
      <Card><Table aria-label="Umsatzsteuer-Vorbereitung"><TableHeader><TableRow><TableHead>Position</TableHead><TableHead numeric>Netto</TableHead><TableHead numeric>Steuer</TableHead></TableRow></TableHeader><TableBody>{report.positions.map((row) => <TableRow key={`${row.code}:${row.direction}`}><TableCell>{row.label}</TableCell><TableCell numeric>{money(row.basisCents)}</TableCell><TableCell numeric>{money(row.taxCents)}</TableCell></TableRow>)}</TableBody></Table>
        {!report.positions.length && <p className="text-control text-muted">Keine Steuerbeträge aus den erfassten Daten im gewählten Zeitraum.</p>}
        <details className="mt-3"><summary className="cursor-pointer text-control">Formularwerte und Belegnachweis</summary><Table aria-label="Steuerquellen"><TableHeader><TableRow><TableHead>Beleg</TableHead><TableHead>Steuerdatum</TableHead><TableHead>Kennziffer</TableHead><TableHead numeric>Netto</TableHead><TableHead numeric>Steuer</TableHead></TableRow></TableHeader><TableBody>{report.sources.map((source, i) => <TableRow key={i}><TableCell>{source.label}</TableCell><TableCell>{source.date}</TableCell><TableCell>{source.code}{source.taxCode ? ` / Steuer ${source.taxCode}` : ''}</TableCell><TableCell numeric>{money(source.basisCents)}</TableCell><TableCell numeric>{money(source.taxCents)}</TableCell></TableRow>)}</TableBody></Table><p className="mt-3 text-caption text-muted">Die CSV enthält zusätzlich die Bemessungsgrundlagen in vollen Euro und die Quellen-IDs.</p></details>
      </Card>
      <Card><h3 className="text-control font-semibold">Zahlungsabstimmung</h3><p className="mt-2 text-control">Rechnungszahlungen {money(report.reconciliation.paymentCashCents)} · zuordenbar {money(report.reconciliation.paymentRecognizedCents)} · Rest {money(report.reconciliation.paymentResidualCents)}</p><p className="mt-2 text-caption text-muted">Zahlungsreste erzeugen keine zusätzliche Umsatzsteuer. Vorsteuer folgt dem geprüften Eingangsbeleg; Teilzahlungen zählen den Beleg nicht mehrfach.</p></Card>
      {!!report.issues.length && <Card><h3 className="text-section">Vor Verwendung prüfen ({report.issues.length})</h3><ul className="mt-3 space-y-2">{report.issues.map((issue, i) => <li key={i} className="text-control">{issue.label && <span className="font-semibold">{issue.label}: </span>}{issue.message}</li>)}</ul></Card>}
      <VatExtensionCard key={year} year={year} />
      <p className="break-all text-caption text-muted">Datenstand {new Date(report.generatedAt).toLocaleString('de-DE')} · Prüfsumme {report.sourceHash}</p>
    </>}
  </div>;
};
