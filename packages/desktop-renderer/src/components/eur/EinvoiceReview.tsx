import React from 'react';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@billme/ui';
import type { IncomingEinvoice, LiteReceipt } from '@billme/server-core';

const euro = (value: number | undefined, currency = 'EUR') =>
  value === undefined ? '–' : value.toLocaleString('de-DE', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'EUR' });
const day = (iso: string | undefined) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE') : '–');
const syntaxLabel = (invoice: IncomingEinvoice) => {
  const profile = invoice.profile ?? '';
  const name = /xrechnung/i.test(profile) ? 'XRechnung' : /factur-x|zugferd/i.test(profile) ? 'ZUGFeRD/Factur-X' : 'EN 16931';
  return `${name} (${invoice.syntax}${invoice.source.kind === 'pdf' ? `, aus PDF-Anhang ${invoice.source.attachmentName ?? ''}` : ''})`;
};
const CATEGORY_LABELS: Record<string, string> = {
  S: 'Normalsatz', AE: 'Steuerschuldnerschaft des Leistungsempfängers', K: 'Innergemeinschaftliche Lieferung',
  G: 'Ausfuhr', E: 'Steuerbefreit', Z: 'Nullsatz', O: 'Nicht steuerbar',
};

/** The e-invoice as a person checks it (Sichtprüfung): parties, dates, lines, VAT, totals, payment. */
export const EinvoiceReview: React.FC<{ invoice: IncomingEinvoice }> = ({ invoice }) => {
  const currency = invoice.currency ?? 'EUR';
  const period = invoice.period?.start || invoice.period?.end ? `${day(invoice.period?.start)} bis ${day(invoice.period?.end)}` : undefined;
  return <section aria-label="E-Rechnung Sichtprüfung" className="flex flex-col gap-3 text-control">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-control font-semibold">{invoice.isCreditNote ? 'Gutschrift' : 'Rechnung'} {invoice.number ?? '–'}</h3>
      <Badge tone="info">{syntaxLabel(invoice)}</Badge>
    </div>
    {invoice.warnings.length > 0 && <ul aria-label="Hinweise zur E-Rechnung" className="flex flex-col gap-1 rounded-control border border-warning-border bg-warning-bg px-3 py-2 text-warning-text">
      {invoice.warnings.map((warning) => <li key={warning}>{warning}</li>)}
    </ul>}
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
      <div><dt className="text-caption text-muted">Rechnungssteller</dt><dd>{invoice.seller.name ?? '–'}<br />{[invoice.seller.street, [invoice.seller.zip, invoice.seller.city].filter(Boolean).join(' '), invoice.seller.country].filter(Boolean).join(', ')}</dd></div>
      <div><dt className="text-caption text-muted">USt-IdNr. / Steuernummer</dt><dd>{[invoice.seller.vatId, invoice.seller.taxId].filter(Boolean).join(' / ') || '–'}</dd></div>
      <div><dt className="text-caption text-muted">Rechnungsempfänger</dt><dd>{invoice.buyer.name ?? '–'}{invoice.buyerReference ? ` · Käuferreferenz ${invoice.buyerReference}` : ''}</dd></div>
      <div><dt className="text-caption text-muted">Rechnungsdatum · fällig</dt><dd>{day(invoice.issueDate)} · {day(invoice.dueDate)}</dd></div>
      <div><dt className="text-caption text-muted">Leistung</dt><dd>{period ?? day(invoice.serviceDate)}</dd></div>
      <div><dt className="text-caption text-muted">Zahlung</dt><dd className="break-all">{invoice.iban ? `IBAN ${invoice.iban}` : '–'}{invoice.bic ? ` · BIC ${invoice.bic}` : ''}{invoice.paymentReference ? ` · Verwendungszweck ${invoice.paymentReference}` : ''}</dd></div>
    </dl>
    <Table aria-label="Rechnungspositionen"><TableHeader><TableRow><TableHead>Position</TableHead><TableHead numeric>Menge</TableHead><TableHead numeric>Einzelpreis</TableHead><TableHead numeric>Steuer</TableHead><TableHead numeric>Netto</TableHead></TableRow></TableHeader>
      <TableBody>{invoice.lines.map((line, index) => <TableRow key={index}><TableCell>{line.description || '–'}</TableCell><TableCell numeric>{line.quantity?.toLocaleString('de-DE') ?? '–'}</TableCell><TableCell numeric>{euro(line.netPrice, currency)}</TableCell><TableCell numeric>{line.vatRate === undefined ? '–' : `${line.vatRate.toLocaleString('de-DE')} %`}</TableCell><TableCell numeric>{euro(line.netAmount, currency)}</TableCell></TableRow>)}</TableBody>
    </Table>
    <Table aria-label="Umsatzsteuer je Steuersatz"><TableHeader><TableRow><TableHead>Steuerkategorie</TableHead><TableHead numeric>Satz</TableHead><TableHead numeric>Netto</TableHead><TableHead numeric>Steuer</TableHead></TableRow></TableHeader>
      <TableBody>{invoice.vatBreakdown.map((group, index) => <TableRow key={index}><TableCell>{CATEGORY_LABELS[group.category] ?? group.category}</TableCell><TableCell numeric>{group.rate.toLocaleString('de-DE')} %</TableCell><TableCell numeric>{euro(group.netAmount, currency)}</TableCell><TableCell numeric>{euro(group.vatAmount, currency)}</TableCell></TableRow>)}</TableBody>
    </Table>
    <dl aria-label="Summen der E-Rechnung" className="ml-auto grid grid-cols-2 gap-x-4 gap-y-1 text-right">
      <dt className="text-muted">Netto</dt><dd>{euro(invoice.totals.net, currency)}</dd>
      <dt className="text-muted">Umsatzsteuer</dt><dd>{euro(invoice.totals.vat, currency)}</dd>
      <dt className="font-semibold">Gesamt</dt><dd className="font-semibold">{euro(invoice.totals.gross, currency)}</dd>
      {invoice.totals.due !== undefined && invoice.totals.due !== invoice.totals.gross && <><dt className="text-muted">Zahlbetrag</dt><dd>{euro(invoice.totals.due, currency)}</dd></>}
    </dl>
    {invoice.notes.length > 0 && <div><p className="text-caption text-muted">Bemerkungen</p>{invoice.notes.map((note, index) => <p key={index} className="whitespace-pre-line">{note}</p>)}</div>}
  </section>;
};

const TAX_MODES: Record<string, LiteReceipt['taxMode']> = {
  S: 'domestic', AE: 'reverse_charge', K: 'intra_eu_acquisition', G: 'exempt', E: 'exempt', Z: 'exempt', O: 'exempt',
};

/**
 * Receipt fields from a received e-invoice. `problems` (German) are what could
 * not be taken over; the tax breakdown then stays as it was. The receipt is
 * never marked reviewed: the person confirms the tax data.
 */
export const receiptFromEinvoice = (invoice: IncomingEinvoice, base: LiteReceipt): { receipt: LiteReceipt; problems: string[] } => {
  const problems: string[] = [];
  const sign = invoice.isCreditNote ? -1 : 1;
  const cents = (value: number) => Math.round(value * 100) * sign;
  const categories = [...new Set(invoice.vatBreakdown.map((group) => group.category))];
  const smallBusiness = !invoice.seller.vatId && invoice.notes.some((note) => /§\s*19|Kleinunternehmer/i.test(note));
  const taxMode = smallBusiness ? 'small_business' : TAX_MODES[categories[0] ?? 'S'] ?? 'domestic';
  const receipt: LiteReceipt = {
    ...base,
    number: invoice.number ?? base.number,
    counterparty: invoice.seller.name ?? base.counterparty,
    documentDate: invoice.issueDate ?? base.documentDate,
    serviceDate: invoice.serviceDate ?? invoice.period?.end ?? invoice.issueDate ?? base.serviceDate,
    reviewed: false,
  };
  if (invoice.currency && invoice.currency !== 'EUR') problems.push(`Währung ${invoice.currency}: Nur Rechnungen in Euro lassen sich übernehmen.`);
  if (categories.length > 1) problems.push(`Mehrere Steuerkategorien (${categories.join(', ')}): Bitte die Steuerdaten von Hand erfassen.`);
  const unsupported = [...new Set(invoice.vatBreakdown.map((group) => group.rate).filter((rate) => ![0, 7, 19].includes(rate)))];
  if (taxMode === 'domestic') for (const rate of unsupported) problems.push(`Steuersatz ${rate.toLocaleString('de-DE')} % wird nicht unterstützt.`);
  if (invoice.totals.gross === undefined) problems.push('Der Rechnungsbetrag fehlt in der E-Rechnung.');
  if (problems.length) return { receipt, problems };

  const byRate = new Map<0 | 7 | 19, { netAmountCents: number; vatAmountCents: number }>();
  for (const group of invoice.vatBreakdown) {
    // Reverse charge and intra-EU acquisition state 0 %; the recipient owes German VAT at the regular rate.
    // ponytail: assumes 19 % for § 13b / ig. Erwerb; a 7 % purchase needs a manual change until the form asks for the rate.
    const selfAssessed = taxMode === 'reverse_charge' || taxMode === 'intra_eu_acquisition';
    const rate = (taxMode === 'exempt' || taxMode === 'small_business' ? 0 : selfAssessed ? 19 : group.rate) as 0 | 7 | 19;
    const net = cents(group.netAmount);
    const vat = rate === 0 ? 0 : selfAssessed ? Math.round(net * rate / 100) : cents(group.vatAmount);
    const current = byRate.get(rate) ?? { netAmountCents: 0, vatAmountCents: 0 };
    byRate.set(rate, { netAmountCents: current.netAmountCents + net, vatAmountCents: current.vatAmountCents + vat });
  }
  return {
    receipt: {
      ...receipt,
      taxMode,
      grossAmountCents: cents(invoice.totals.gross!),
      taxBreakdown: byRate.size ? [...byRate].map(([rate, amounts]) => ({ rate, ...amounts })) : base.taxBreakdown,
      correctionReason: invoice.isCreditNote ? base.correctionReason ?? `Gutschrift ${invoice.number ?? ''}`.trim() : base.correctionReason,
    },
    problems,
  };
};
