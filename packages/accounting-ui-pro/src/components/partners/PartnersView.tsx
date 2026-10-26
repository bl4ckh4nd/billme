import React, { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, CardHeader, EmptyState, ErrorState, Input, Metric, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  TimeSeriesChart, cn,
} from '@billme/ui';
import { readAnalysisYear, writeAnalysisYear } from '@billme/accounting-shared';
import type { LedgerPartnerDetail, LedgerPartners, ProAccountingDataAdapter } from '../../services/accountingDataAdapter';

void React;

type SortKey = 'name' | 'income' | 'expense' | 'net' | 'count' | 'lastDate';

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const axis = (value: number) => (Math.abs(value) >= 1000 ? `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })}k` : String(Math.round(value)));
const date = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const monthDate = (period: string) => new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1);
const PAGE = 100;
const tile = 'rounded-tile border border-border bg-surface px-4 py-3.5';
const SORT_LABEL: Record<SortKey, string> = { name: 'Name', income: 'Einnahmen', expense: 'Ausgaben', net: 'Netto', count: 'Buchungen', lastDate: 'Zeitraum' };

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  onOpenEntry?: (entryId: string) => void;
};

/**
 * Geschäftspartner from the journal: who the money came from and went to, named by the bank line's counterparty or
 * the start of the booking text. Totals per partner for a year or all years; a partner shows its months and bookings.
 */
export default function PartnersView({ dataAdapter, onOpenEntry }: Props) {
  const [year, setYear] = useState(() => readAnalysisYear() ?? String(new Date().getFullYear()));
  const [years, setYears] = useState<number[]>([]);
  const [data, setData] = useState<LedgerPartners | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'net', descending: true });
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LedgerPartnerDetail | null>(null);

  // Years with bookings on a money account: those a partner can have.
  useEffect(() => {
    if (!dataAdapter?.getMoneyAccountYear) return;
    let current = true;
    dataAdapter.getMoneyAccountYear({}).then((account) => {
      if (!current) return;
      const first = Math.min(...account.accounts.map((entry) => entry.firstYear));
      const last = Math.max(...account.accounts.map((entry) => entry.lastYear));
      const list = Number.isFinite(first) ? Array.from({ length: last - first + 1 }, (_, index) => last - index) : [];
      setYears(list);
      setYear((value) => (value === 'all' || list.includes(Number(value)) ? value : String(list[0] ?? value)));
    }).catch(() => undefined);
    return () => { current = false; };
  }, [dataAdapter]);

  useEffect(() => {
    if (!dataAdapter?.getLedgerPartners) return;
    let current = true;
    setError(null);
    dataAdapter.getLedgerPartners(year === 'all' ? {} : { from: `${year}-01-01`, to: `${year}-12-31` })
      .then((next) => { if (current) { setData(next); setShown(PAGE); } })
      .catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message : 'Geschäftspartner nicht erreichbar.'); });
    return () => { current = false; };
  }, [dataAdapter, year, retry]);

  useEffect(() => {
    if (!selected || !dataAdapter?.getLedgerPartnerDetail) { setDetail(null); return; }
    let current = true;
    dataAdapter.getLedgerPartnerDetail({ name: selected, ...(year === 'all' ? {} : { from: `${year}-01-01`, to: `${year}-12-31` }) })
      .then((next) => { if (current) setDetail(next); })
      .catch(() => { if (current) setDetail(null); });
    return () => { current = false; };
  }, [dataAdapter, selected, year]);

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('de-DE');
    const list = (data?.partners ?? []).filter((partner) => !needle || partner.name.toLocaleLowerCase('de-DE').includes(needle) || (partner.topAccount ?? '').toLocaleLowerCase('de-DE').includes(needle));
    const value = (partner: LedgerPartners['partners'][number]) => sort.key === 'name' ? partner.name.toLocaleLowerCase('de-DE') : sort.key === 'lastDate' ? partner.lastDate : sort.key === 'net' ? Math.abs(partner.net) : partner[sort.key];
    return [...list].sort((a, b) => {
      const left = value(a); const right = value(b);
      const order = typeof left === 'string' ? left.localeCompare(String(right), 'de-DE') : Number(left) - Number(right);
      return sort.descending ? -order : order;
    });
  }, [data, search, sort]);

  if (!dataAdapter?.getLedgerPartners) return null;
  if (error) return <ErrorState title="Geschäftspartner nicht erreichbar" description={error} onRetry={() => setRetry((value) => value + 1)} />;

  const partners = data?.partners ?? [];
  const topIncome = [...partners].sort((a, b) => b.income - a.income)[0];
  const topExpense = [...partners].sort((a, b) => b.expense - a.expense)[0];
  const toggleSort = (key: SortKey) => setSort((current) => ({ key, descending: current.key === key ? !current.descending : key !== 'name' }));

  return (
    <div className="flex flex-col gap-3.5" data-testid="partners-view">
      <h2 className="sr-only">Geschäftspartner</h2>
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Jahr" aria-label="Jahr der Geschäftspartner" value={year} onChange={(event) => { setYear(event.target.value); writeAnalysisYear(event.target.value); setSelected(null); }}>
          {years.map((entry) => <option key={entry} value={String(entry)}>{entry}</option>)}
          {years.length > 1 ? <option value="all">Alle Jahre</option> : null}
          {!years.length ? <option value={year}>{year}</option> : null}
        </Select>
        <Input label="Suche" aria-label="Geschäftspartner suchen" value={search} onChange={(event) => { setSearch(event.target.value); setShown(PAGE); }} placeholder="Name oder Konto" className="min-w-[16rem]" />
      </div>

      <section aria-label="Kennzahlen Geschäftspartner" className="grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-3">
        <div className={tile}><Metric marker="tick" label="Geschäftspartner" value={String(partners.length)} hint={`${partners.reduce((sum, partner) => sum + partner.count, 0)} Buchungen mit Geldbewegung`} /></div>
        <div className={tile}><Metric marker="tick" label="Größter Einnahme-Partner" value={topIncome && topIncome.income > 0 ? euro(topIncome.income) : '–'} hint={topIncome && topIncome.income > 0 ? topIncome.name : undefined} /></div>
        <div className={tile}><Metric marker="tick" label="Größter Ausgabe-Partner" value={topExpense && topExpense.expense > 0 ? euro(topExpense.expense) : '–'} hint={topExpense && topExpense.expense > 0 ? topExpense.name : undefined} /></div>
      </section>

      {selected && detail ? (
        <section aria-label={`Geschäftspartner ${detail.name}`} data-testid="partner-detail">
        <Card radius="2xl" padding="lg" className="pt-4">
          <CardHeader
            size="lg"
            title={detail.name}
            subtitle={`${detail.count} ${detail.count === 1 ? 'Buchung' : 'Buchungen'}: Einnahmen ${euro(detail.income)}, Ausgaben ${euro(detail.expense)}, netto ${euro(detail.net)}`}
            actions={<Button type="button" size="sm" variant="secondary" onClick={() => setSelected(null)}>Schließen</Button>}
          />
          {detail.months.length ? (
            <div className="mt-3 rounded-card border border-border bg-surface-muted p-3.5">
              <TimeSeriesChart
                aria-label={`Ein- und Ausgänge ${detail.name}`}
                formatValue={euro}
                formatAxis={axis}
                height={200}
                series={[
                  { key: 'income', label: 'Einnahmen', kind: 'bar', style: 'solid', stack: 'flow' },
                  { key: 'expense', label: 'Ausgaben', kind: 'bar', style: 'hatched', stack: 'flow', downward: true },
                ]}
                data={detail.months.map((month) => ({
                  key: month.period,
                  label: `${monthDate(month.period).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '')} ${month.period.slice(2, 4)}`,
                  longLabel: monthDate(month.period).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
                  values: { income: month.income, expense: month.expense },
                }))}
              />
            </div>
          ) : null}
          <Table bare aria-label={`Buchungen ${detail.name}`} containerClassName="mt-3 max-h-[20rem]">
            <TableHeader>
              <TableRow><TableHead>Datum</TableHead><TableHead>Beleg</TableHead><TableHead>Buchungstext</TableHead><TableHead numeric>Betrag</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {detail.entries.map((entry) => (
                <TableRow key={entry.entryId} className={onOpenEntry ? 'cursor-pointer' : undefined} onClick={onOpenEntry ? () => onOpenEntry(entry.entryId) : undefined}>
                  <TableCell className="tabular-nums">{date(entry.postingDate)}</TableCell>
                  <TableCell>{entry.reference ?? entry.entryNumber}</TableCell>
                  <TableCell>{entry.bookingText}</TableCell>
                  <TableCell numeric className={entry.amount < 0 ? 'text-error-text' : 'text-success-text'}>{euro(entry.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        </section>
      ) : null}

      <Card padding="none" className="overflow-hidden">
        <CardHeader className="border-b border-border px-3.5 py-3" title="Alle Geschäftspartner" count={`${rows.length} von ${partners.length}`} subtitle="Name aus der Bankzeile oder dem Anfang des Buchungstexts. Umbuchungen zwischen eigenen Konten zählen nicht." />
        {!data ? (
          <p className="p-3.5 text-caption text-muted" role="status">Wird geladen…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="Keine Geschäftspartner" description="Partner erscheinen hier, sobald im Zeitraum Geld auf einem Bank-, Kassen- oder Kartenkonto bewegt wurde." />
        ) : (
          <>
            <Table bare aria-label="Geschäftspartner">
              <TableHeader>
                <TableRow>
                  {(['name', 'income', 'expense', 'net', 'count', 'lastDate'] as SortKey[]).map((key) => (
                    <TableHead key={key} numeric={key !== 'name' && key !== 'lastDate'} aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
                      <button type="button" className="font-inherit uppercase" onClick={() => toggleSort(key)}>
                        {SORT_LABEL[key]}{sort.key === key ? (sort.descending ? ' ▼' : ' ▲') : ''}
                      </button>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, shown).map((partner) => (
                  <TableRow key={partner.name} className={cn('cursor-pointer', selected === partner.name && 'bg-surface-muted')} onClick={() => setSelected(partner.name)}>
                    <TableCell>
                      <div className="font-medium">{partner.name}</div>
                      {partner.topAccount ? <div className="text-caption text-muted">{partner.topAccount}</div> : null}
                    </TableCell>
                    <TableCell numeric>{partner.income ? euro(partner.income) : '–'}</TableCell>
                    <TableCell numeric>{partner.expense ? euro(partner.expense) : '–'}</TableCell>
                    <TableCell numeric className={cn('font-medium', partner.net < 0 ? 'text-error-text' : 'text-success-text')}>{euro(partner.net)}</TableCell>
                    <TableCell numeric muted>{partner.count}</TableCell>
                    <TableCell className="tabular-nums text-caption text-muted">{date(partner.firstDate)} – {date(partner.lastDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length > shown ? (
              <div className="flex justify-center border-t border-border p-3">
                <Button type="button" variant="secondary" onClick={() => setShown((value) => value + PAGE)}>Weitere {Math.min(PAGE, rows.length - shown)} anzeigen</Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
