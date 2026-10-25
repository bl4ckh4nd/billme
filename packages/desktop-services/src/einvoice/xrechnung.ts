import type { AppSettings, Invoice } from '@billme/desktop-core/types';
import { isBillingDocumentKind } from '@billme/desktop-core/types';
import { serverRenderDocumentSchema, toDesktopRenderContext } from '../documentRenderContext';
import { normalizeInvoiceForEinvoice } from './normalizeInvoiceForEinvoice';
import { buildZugferdXml } from './zugferdXml';

/** A request the e-invoice code refuses; the HTTP error handler answers with `statusCode`. */
export class EinvoiceRequestError extends Error {
  constructor(message: string, readonly statusCode: 400 | 422) {
    super(message);
    this.name = 'EinvoiceRequestError';
  }
}

/**
 * XRechnung 3.0 (CII) of an issued billing document. Refuses with a German list
 * of what is missing for the XRechnung CIUS (BR-DE-*) before building anything.
 */
export const buildXRechnung = (
  invoice: Invoice,
  settings: AppSettings,
  source?: { number: string; date: string },
): { fileName: string; xml: string } => {
  if (!isBillingDocumentKind(invoice.documentKind)) {
    throw new EinvoiceRequestError('Eine XRechnung gibt es nur für Rechnungen, Gutschriften und Stornorechnungen.', 422);
  }
  if (invoice.status === 'draft') {
    throw new EinvoiceRequestError('Die Rechnung ist noch ein Entwurf. Eine XRechnung gibt es erst für gestellte Rechnungen.', 422);
  }
  const missing = [
    !(invoice.taxMeta as { buyerReference?: string } | undefined)?.buyerReference?.trim() && 'Leitweg-ID/Käuferreferenz (BT-10)',
    !settings.company.email?.trim() && 'E-Mail deines Unternehmens (BT-43)',
    !settings.company.phone?.trim() && 'Telefonnummer deines Unternehmens (BT-42)',
    // BR-DE-13: a payment instruction; Billme states a SEPA transfer.
    !settings.finance.iban?.trim() && 'IBAN deines Unternehmens (BT-84)',
    !invoice.clientEmail?.trim() && 'E-Mail des Kunden (BT-49)',
  ].filter((entry): entry is string => Boolean(entry));
  if (missing.length) throw new EinvoiceRequestError(`XRechnung nicht möglich, es fehlt: ${missing.join(', ')}.`, 422);

  let xml: string;
  try {
    xml = buildZugferdXml(normalizeInvoiceForEinvoice(invoice, settings, source), { profile: 'xrechnung' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EinvoiceRequestError(message.replace('ZUGFeRD Export fehlgeschlagen', 'XRechnung nicht möglich').replace(/ Ein normales PDF .*$/, ''), 422);
  }
  return { fileName: `${invoice.number.trim().replace(/[^\w.-]+/g, '_')}_xrechnung.xml`, xml };
};

/** Same, from the server's render context (frozen sender data of an issued invoice). */
export const buildXRechnungFromRenderContext = (context: { document: unknown; settings: unknown; source?: { number: string; date: string } }) => {
  const { document } = toDesktopRenderContext({ document: serverRenderDocumentSchema.parse(context.document) });
  if (!context.settings) throw new EinvoiceRequestError('XRechnung nicht möglich: Die Unternehmensdaten fehlen.', 422);
  return buildXRechnung(document as Invoice, context.settings as AppSettings, context.source);
};
