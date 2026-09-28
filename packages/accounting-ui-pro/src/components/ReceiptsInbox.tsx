import { useEffect, useMemo, useState } from 'react';
import type { IncomingInvoiceDocumentEntity, IncomingInvoiceEntity, VendorEntity } from '@billme/accounting-shared';
import {
  Badge, EmptyState, ErrorState, SegmentedControl,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';

type Filter = 'all' | 'review' | 'missing' | 'posted';

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const date = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

/**
 * Belege: every incoming invoice with the state of its archived originals, so
 * missing and unreviewed receipts surface in one place. Opening a row hands
 * the invoice to Offene Posten, where documents are uploaded and reviewed.
 */
export default function ReceiptsInbox({ dataAdapter, onOpenInvoice }: {
  dataAdapter?: ProAccountingDataAdapter;
  onOpenInvoice: (invoiceId: string) => void;
}) {
  const [invoices, setInvoices] = useState<IncomingInvoiceEntity[]>([]);
  const [documents, setDocuments] = useState<IncomingInvoiceDocumentEntity[]>([]);
  const [vendors, setVendors] = useState<VendorEntity[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading');
  const [filter, setFilter] = useState<Filter>('all');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!dataAdapter?.listIncomingInvoices || !dataAdapter.listIncomingInvoiceDocuments || !dataAdapter.listVendors) {
      setState('unavailable');
      return;
    }
    let active = true;
    setState('loading');
    Promise.all([dataAdapter.listIncomingInvoices(), dataAdapter.listIncomingInvoiceDocuments(), dataAdapter.listVendors()])
      .then(([nextInvoices, nextDocuments, nextVendors]) => {
        if (!active) return;
        setInvoices(nextInvoices);
        setDocuments(nextDocuments);
        setVendors(nextVendors);
        setState('ready');
      })
      .catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [dataAdapter, attempt]);

  const rows = useMemo(() => {
    const vendorName = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
    const docsByInvoice = new Map<string, IncomingInvoiceDocumentEntity[]>();
    for (const document of documents) docsByInvoice.set(document.incomingInvoiceId, [...(docsByInvoice.get(document.incomingInvoiceId) ?? []), document]);
    return invoices
      .filter((invoice) => invoice.status !== 'cancelled')
      .map((invoice) => {
        const docs = docsByInvoice.get(invoice.id) ?? [];
        return {
          invoice,
          vendor: vendorName.get(invoice.vendorId) ?? 'Unbekannter Lieferant',
          docs,
          pending: docs.some((document) => document.reviewStatus === 'pending'),
          rejected: docs.length > 0 && docs.every((document) => document.reviewStatus === 'rejected'),
        };
      });
  }, [invoices, documents, vendors]);

  const counts = {
    review: rows.filter((row) => row.pending).length,
    missing: rows.filter((row) => row.docs.length === 0 || row.rejected).length,
    posted: rows.filter((row) => row.invoice.accountingStatus === 'posted').length,
  };
  const visible = rows.filter((row) =>
    filter === 'review' ? row.pending
      : filter === 'missing' ? row.docs.length === 0 || row.rejected
        : filter === 'posted' ? row.invoice.accountingStatus === 'posted'
          : true);

  if (state === 'unavailable') return <div className="p-6 text-sm text-muted">Belege sind in dieser Verbindung nicht verfügbar.</div>;
  if (state === 'error') return <ErrorState title="Belege konnten nicht geladen werden" description="Eingangsrechnungen oder Dokumente sind nicht erreichbar." onRetry={() => setAttempt((n) => n + 1)} />;

  return (
    <section aria-labelledby="receipts-title" className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="receipts-title" className="mr-auto text-section">Eingangsrechnungen und Originalbelege</h2>
        <SegmentedControl
          aria-label="Belege filtern"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `Alle (${rows.length})` },
            { value: 'review', label: `Zu prüfen (${counts.review})` },
            { value: 'missing', label: `Ohne Beleg (${counts.missing})` },
            { value: 'posted', label: `Gebucht (${counts.posted})` },
          ]}
        />
      </div>
      <div className="rounded-panel bg-surface shadow-xs">
        {state === 'loading' ? (
          <p className="p-6 text-sm text-muted" role="status">Belege werden geladen …</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? 'Noch keine Eingangsrechnungen' : 'Nichts in diesem Filter'}
            description={rows.length === 0 ? 'Eingangsrechnungen werden unter Offene Posten erfasst; ihre Originale erscheinen dann hier.' : 'Wählen Sie einen anderen Filter.'}
            className="py-10"
          />
        ) : (
          <Table aria-label="Belege" density="compact" bare>
            <TableHeader>
              <TableRow>
                <TableHead>Rechnung</TableHead>
                <TableHead>Lieferant</TableHead>
                <TableHead>Datum</TableHead>
                <TableHead numeric>Brutto</TableHead>
                <TableHead>Originalbeleg</TableHead>
                <TableHead>Buchung</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ invoice, vendor, docs, pending, rejected }) => (
                <TableRow key={invoice.id} data-receipt-row={invoice.id}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onOpenInvoice(invoice.id)}
                      className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus-ring"
                      aria-label={`Eingangsrechnung ${invoice.number} öffnen`}
                    >
                      {invoice.number}
                    </button>
                  </TableCell>
                  <TableCell>{vendor}</TableCell>
                  <TableCell className="tabular-nums">{date(invoice.invoiceDate)}</TableCell>
                  <TableCell numeric>{euro(invoice.grossAmount)}</TableCell>
                  <TableCell>
                    {docs.length === 0 ? <Badge tone="warning">Fehlt</Badge>
                      : rejected ? <Badge tone="error">Abgelehnt</Badge>
                        : pending ? <Badge tone="info">Zu prüfen</Badge>
                          : <Badge tone="success">{docs.length === 1 ? docs[0].originalFilename : `${docs.length} Dateien geprüft`}</Badge>}
                  </TableCell>
                  <TableCell>
                    <Badge tone={invoice.accountingStatus === 'posted' ? 'success' : invoice.accountingStatus === 'unresolved' ? 'warning' : 'neutral'}>
                      {invoice.accountingStatus === 'posted' ? 'Gebucht' : invoice.accountingStatus === 'reversed' ? 'Storniert' : invoice.accountingStatus === 'unresolved' ? 'Ungeklärt' : 'Nicht gebucht'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
