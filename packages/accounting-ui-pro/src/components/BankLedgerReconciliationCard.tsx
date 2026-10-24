import React, { useEffect, useState } from 'react';
import { Badge, Card, CardHeader } from '@billme/ui';
import type { BankLedgerReconciliationRow, ProAccountingDataAdapter } from '../services/accountingDataAdapter';

void React;

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);

/** Booked bank lines against the ledger account of their bank account; a difference is shown, not hidden. */
export default function BankLedgerReconciliationCard({ dataAdapter, refreshToken = 0 }: { dataAdapter?: ProAccountingDataAdapter; refreshToken?: number }) {
  const [rows, setRows] = useState<BankLedgerReconciliationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    if (!dataAdapter?.getBankLedgerReconciliation) return;
    dataAdapter.getBankLedgerReconciliation()
      .then((next) => { if (current) { setRows(next); setError(null); } })
      .catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message : 'Abstimmung konnte nicht geladen werden.'); });
    return () => { current = false; };
  }, [dataAdapter, refreshToken]);

  if (!dataAdapter?.getBankLedgerReconciliation) return null;
  return (
    <section aria-label="Abstimmung Bank und Hauptbuch" data-testid="bank-ledger-reconciliation">
      <Card padding="none" className="overflow-hidden">
        <CardHeader
          as="h3"
          className="border-b border-border px-3.5 py-3"
          title="Abstimmung Bank und Hauptbuch"
          subtitle="Gebuchte Bankzeilen gegen den Saldo des Bankkontos im Hauptbuch. Eine Differenz entsteht durch Buchungen auf dem Bankkonto ohne Bankzeile oder umgekehrt."
        />
        {error ? <p role="alert" className="px-3.5 py-3 text-control text-error-text">{error}</p>
          : !rows ? <p className="px-3.5 py-3 text-control text-muted" role="status">Abstimmung wird geladen…</p>
          : rows.length === 0 ? <p className="px-3.5 py-3 text-control text-muted">Noch keine Bankzeilen importiert.</p>
          : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li key={row.ledgerAccountNumber} data-ledger-account={row.ledgerAccountNumber} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 text-control">
                  <span className="w-24 font-semibold text-foreground tabular-nums">Konto {row.ledgerAccountNumber}</span>
                  <span className="tabular-nums text-muted">Bankzeilen gebucht {euro(row.bookedBankTotal)}</span>
                  <span className="tabular-nums text-muted">Hauptbuch {euro(row.ledgerBalance)}</span>
                  {row.pendingCount > 0 ? <span className="tabular-nums text-muted">{row.pendingCount} offen ({euro(row.pendingTotal)})</span> : null}
                  <span className="flex-1" />
                  {Math.abs(row.difference) >= 0.005
                    ? <Badge tone="warning">Differenz {euro(row.difference)}</Badge>
                    : <Badge tone="success">stimmt überein</Badge>}
                </li>
              ))}
            </ul>
          )}
      </Card>
    </section>
  );
}
