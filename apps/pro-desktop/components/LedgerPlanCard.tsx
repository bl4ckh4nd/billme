import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, Card, CardHeader, Input } from '@billme/ui';
import { useSaveLedgerAccountMutation } from '../hooks/useProLedger';

type LedgerRow = { chart: 'SKR03' | 'SKR04'; accountNumber: string; name: string; source: string; active?: boolean };

const errorText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/ACCOUNT_IN_USE/.test(message)) return 'Das Konto ist als Standardkonto zugeordnet und kann nicht deaktiviert werden.';
  if (/INVALID_ACCOUNT_NAME/.test(message)) return 'Ein eigenes Konto braucht eine Bezeichnung mit höchstens 40 Zeichen.';
  if (/INVALID_ACCOUNT_NUMBER|accountNumber/.test(message)) return 'Kontonummern haben 4 bis 8 Ziffern.';
  return `Speichern fehlgeschlagen: ${message}`;
};

/**
 * Kontenplan: own accounts of the tenant and deactivated accounts. A deactivated account takes no new
 * postings; its entries stay and can still be reversed. DATEV accounts keep their DATEV name.
 */
export function LedgerPlanCard({ chart, accounts }: { chart: 'SKR03' | 'SKR04'; accounts: LedgerRow[] }): ReactElement {
  const save = useSaveLedgerAccountMutation();
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const listed = accounts.filter((row) => row.source === 'tenant' || row.active === false);
  const known = accounts.find((row) => row.accountNumber === number.trim());

  const run = async (input: { accountNumber: string; name?: string; active: boolean }, done: string) => {
    setNotice(null);
    try {
      await save.mutateAsync({ chart, ...input, reason: done });
      setNotice({ text: done, error: false });
      return true;
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
      return false;
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const accountNumber = number.trim();
    if (!accountNumber) return;
    const ok = known
      ? await run({ accountNumber, active: false }, `Konto ${accountNumber} deaktiviert`)
      : await run({ accountNumber, name: name.trim(), active: true }, `Konto ${accountNumber} angelegt`);
    if (ok) { setNumber(''); setName(''); }
  };

  return (
    <section aria-labelledby="ledger-plan-heading">
      <Card>
        <CardHeader
          as="h2"
          title={<span id="ledger-plan-heading">Kontenplan ({chart})</span>}
          subtitle="Eigene Konten anlegen oder Konten deaktivieren. Deaktivierte Konten nehmen keine neuen Buchungen an; bestehende Buchungen bleiben und lassen sich stornieren."
        />
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => void submit(event)}>
          <Input label="Kontonummer" inputMode="numeric" pattern="\d{4,8}" value={number} onChange={(event) => setNumber(event.target.value)} className="font-mono tabular-nums" />
          <Input
            label="Bezeichnung"
            maxLength={40}
            value={known ? known.name : name}
            disabled={Boolean(known)}
            hint={known ? (known.active === false ? 'Konto ist bereits deaktiviert.' : 'Konto aus dem Kontenrahmen.') : 'Für ein eigenes Konto, höchstens 40 Zeichen.'}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={save.isPending || !number.trim() || known?.active === false || (!known && !name.trim())} aria-busy={save.isPending}>
            {known ? 'Deaktivieren' : 'Konto anlegen'}
          </Button>
        </form>
        {notice ? <p role={notice.error ? 'alert' : 'status'} className={`mt-2 text-control ${notice.error ? 'text-error-text' : 'text-foreground'}`}>{notice.text}</p> : null}
        {listed.length ? (
          <table className="mt-3 w-full text-control">
            <caption className="sr-only">Eigene und deaktivierte Konten</caption>
            <thead><tr className="text-left text-muted"><th className="py-1 font-medium">Konto</th><th className="py-1 font-medium">Bezeichnung</th><th className="py-1 font-medium">Status</th><th className="py-1" /></tr></thead>
            <tbody>
              {listed.map((row) => (
                <tr key={row.accountNumber} className="border-t border-border">
                  <td className="py-1 font-mono tabular-nums">{row.accountNumber}</td>
                  <td className="py-1">{row.name}{row.source === 'tenant' ? <span className="ml-2 text-caption text-muted">eigenes Konto</span> : null}</td>
                  <td className="py-1">{row.active === false ? 'deaktiviert' : 'aktiv'}</td>
                  <td className="py-1 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={save.isPending}
                      onClick={() => void run({ accountNumber: row.accountNumber, active: row.active === false }, row.active === false ? `Konto ${row.accountNumber} aktiviert` : `Konto ${row.accountNumber} deaktiviert`)}
                    >
                      {row.active === false ? 'Aktivieren' : 'Deaktivieren'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="mt-3 text-caption text-muted">Noch keine eigenen oder deaktivierten Konten.</p>}
      </Card>
    </section>
  );
}
