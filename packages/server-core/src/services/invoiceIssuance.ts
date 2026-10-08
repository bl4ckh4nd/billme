import type { Invoice, InvoiceTaxMode } from '../domain/foundations.js';
import { getBillingLineAmount, isBillableLine } from '../domain/billing-lines.js';
import { getInvoiceTaxModeDefinition, resolveInvoiceTaxMode } from './taxMode.js';

/** What issuing needs from the seller's settings. */
export interface IssuerSettings {
  company: { name?: string; street?: string; zip?: string; city?: string };
  finance: { taxId?: string; vatId?: string };
  legal: { smallBusinessRule?: boolean; defaultVatRate?: number; countryCode?: string };
}

export class InvoiceIssueError extends Error {
  readonly statusCode = 422;
  constructor(readonly missing: string[]) {
    super(`Die Rechnung kann so nicht gestellt werden: ${missing.join('; ')}.`);
    this.name = 'InvoiceIssueError';
  }
}

const filled = (value: string | undefined | null): boolean => Boolean(value?.trim());

/** §19 Abs. 1 UStG since 2025: net turnover (vereinnahmte Entgelte) of the previous and the current calendar year. */
export interface SmallBusinessTurnover { priorYear: number; currentYear: number }
export const SMALL_BUSINESS_PRIOR_YEAR_LIMIT = 25_000;
export const SMALL_BUSINESS_CURRENT_YEAR_LIMIT = 100_000;

/**
 * Modes a Kleinunternehmer may invoice with: its domestic turnover is tax-free under §19, §13b does not
 * apply to it (§13b Abs. 5 UStG), and §19 excludes the exemptions for exports and intra-EU supplies.
 * Services whose place of supply is abroad are not taxable in Germany at all.
 */
const SMALL_BUSINESS_MODES: ReadonlySet<InvoiceTaxMode> = new Set(['small_business_19_ustg', 'non_taxable_outside_scope', 'intra_eu_service_reverse_charge']);

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);

/**
 * The tax mode a document is issued with. The schema defaults a missing mode to
 * standard VAT, so for a Kleinunternehmer a standard mode means "not chosen":
 * it must never put VAT on the invoice (§19 UStG, otherwise owed under §14c).
 */
export const resolveIssueTaxMode = (taxMode: InvoiceTaxMode | undefined, settings: Pick<IssuerSettings, 'legal'>): InvoiceTaxMode =>
  settings.legal.smallBusinessRule && (!taxMode || taxMode === 'standard_vat')
    ? 'small_business_19_ustg'
    : resolveInvoiceTaxMode(taxMode, settings);

/**
 * §14 Abs. 4 UStG at the moment an invoice (or a correction of one) is issued:
 * seller and buyer with address, the seller's Steuernummer or USt-IdNr., at least
 * one priced line, a due date not before the invoice date, the buyer's VAT ID where
 * the tax mode needs it and the seller's for intra-EU supplies (§14a). A missing service date becomes the
 * invoice date, so the stored document says what the PDF prints. Drafts are not
 * checked.
 */
export const prepareInvoiceForIssue = <T extends Invoice>(invoice: T, settings: IssuerSettings, turnover?: SmallBusinessTurnover): T => {
  const missing: string[] = [];
  const kind = invoice.documentKind ?? 'invoice';
  // Order confirmations and delivery notes are no invoices; corrections copy an issued one and must stay possible.
  if (kind === 'order_confirmation' || kind === 'delivery_note' || kind === 'credit_note' || kind === 'cancellation_invoice') return invoice;

  if (!filled(settings.company.name) || !filled(settings.company.street) || !filled(settings.company.zip) || !filled(settings.company.city)) {
    missing.push('Name und vollständige Anschrift deines Unternehmens fehlen (Einstellungen → Stammdaten)');
  }
  if (!filled(settings.finance.taxId) && !filled(settings.finance.vatId)) {
    missing.push('Steuernummer oder USt-IdNr. deines Unternehmens fehlt (Einstellungen → Finanzen)');
  }
  if (!filled(invoice.client)) missing.push('Kundenname fehlt');
  const address = invoice.billingAddress;
  const hasStructuredAddress = Boolean(address && filled(address.street) && filled(address.city) && (filled(address.zip) || filled(address.postalCode)));
  if (!hasStructuredAddress && !filled(invoice.clientAddress)) missing.push('Anschrift des Kunden fehlt');
  if (!invoice.items.some((line) => isBillableLine(line) && getBillingLineAmount(line) !== 0)) missing.push('mindestens eine Position mit Betrag fehlt');
  if (invoice.dueDate && invoice.dueDate.slice(0, 10) < invoice.date.slice(0, 10)) missing.push('das Fälligkeitsdatum liegt vor dem Rechnungsdatum');

  const mode = resolveIssueTaxMode(invoice.taxMode, settings);
  const definition = getInvoiceTaxModeDefinition(mode);
  if (mode === 'small_business_19_ustg' && !settings.legal.smallBusinessRule) {
    missing.push('die Kleinunternehmerregelung ist in den Einstellungen nicht aktiv');
  }
  if (settings.legal.smallBusinessRule && !SMALL_BUSINESS_MODES.has(mode)) {
    missing.push(`„${definition.label}“ ist für Kleinunternehmer nicht möglich (§19 UStG, §13b Abs. 5 UStG)`);
  }
  if (mode === 'small_business_19_ustg' && settings.legal.smallBusinessRule && turnover) {
    if (turnover.priorYear > SMALL_BUSINESS_PRIOR_YEAR_LIMIT) {
      missing.push(`der Vorjahresumsatz von ${euro(turnover.priorYear)} übersteigt ${euro(SMALL_BUSINESS_PRIOR_YEAR_LIMIT)}; die Kleinunternehmerregelung gilt in diesem Jahr nicht (§19 Abs. 1 UStG). Bitte in den Einstellungen abschalten`);
    } else if (turnover.currentYear + Math.max(0, invoice.amount) > SMALL_BUSINESS_CURRENT_YEAR_LIMIT) {
      missing.push(`mit dieser Rechnung übersteigt der Umsatz des Jahres (bisher ${euro(turnover.currentYear)} vereinnahmt) ${euro(SMALL_BUSINESS_CURRENT_YEAR_LIMIT)}; ab diesem Umsatz gilt die Regelbesteuerung (§19 Abs. 1 UStG). Bitte die Kleinunternehmerregelung abschalten und mit Umsatzsteuer abrechnen`);
    }
  }
  if (definition.requiresBuyerVatId && !filled(invoice.taxMeta?.buyerVatId)) missing.push(`USt-IdNr. des Kunden fehlt (Pflicht bei „${definition.label}“)`);
  // §14a Abs. 1: an intra-EU supply or service names both VAT IDs; a domestic §13b invoice needs only the tax number.
  if (mode.startsWith('intra_eu') && !filled(settings.finance.vatId)) missing.push(`deine USt-IdNr. fehlt (Pflicht bei „${definition.label}“, §14a UStG)`);
  if (missing.length) throw new InvoiceIssueError(missing);

  // An advance invoice bills a service still to come; it gets no service date of its own.
  const servicePeriod = filled(invoice.servicePeriod) || kind === 'advance_invoice' ? invoice.servicePeriod : invoice.date;
  return { ...invoice, taxMode: mode, servicePeriod };
};

/** A service period stored as "YYYY-MM-DD bis YYYY-MM-DD" (recurring invoices); a single date otherwise. */
export const servicePeriodRange = (value: string | undefined): { start: string; end: string } | undefined => {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2}) bis (\d{4}-\d{2}-\d{2})$/);
  return match ? { start: match[1]!, end: match[2]! } : undefined;
};

/** The day a service counts as rendered: the end of a period (§13 Abs. 1 Nr. 1a UStG, Teilleistung), else the date itself. */
export const serviceDateOf = (value: string | undefined): string | undefined => servicePeriodRange(value)?.end ?? value;
