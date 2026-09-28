import type { AppSettings, Invoice } from '@billme/desktop-core/types';
import { getInvoiceDocumentLabel, isBillingDocumentKind } from '@billme/desktop-core/types';
import type { EmbeddedConnectionResult } from '@billme/desktop-contracts/embeddedConnection';
import { serverRenderDocumentSchema, toDesktopRenderContext } from './documentRenderContext';
import { buildZugferdXml } from './einvoice/zugferdXml';
import { embedZugferdInPdf } from './einvoice/embedZugferdInPdf';
import { normalizeInvoiceForEinvoice } from './einvoice/normalizeInvoiceForEinvoice';

export type PreparedDocumentExport = {
  suggestedName: string;
  /** Post-processes the printed PDF, e.g. embeds the ZUGFeRD XML. */
  finalize?: (pdf: Uint8Array) => Promise<Uint8Array>;
};

/**
 * Main-process side of `pdf:export`: reads the same render context the print
 * window renders from, names the file after the document and, for billing
 * documents with e-invoicing enabled, embeds the ZUGFeRD XML.
 */
export const createDocumentExportPreparer = (options: {
  product: 'lite' | 'pro';
  resolveConnection: () => EmbeddedConnectionResult;
  fetch?: typeof globalThis.fetch;
}) => async (kind: 'invoice' | 'offer' | 'dunning', id: string, level?: number): Promise<PreparedDocumentExport> => {
  const connection = options.resolveConnection();
  if (!connection) throw new Error('Der lokale Billme-Server ist noch nicht verfügbar.');
  const response = await (options.fetch ?? globalThis.fetch)(
    `${connection.baseUrl.replace(/\/+$/, '')}/api/v1/${options.product}/documents/${kind}/${encodeURIComponent(id)}/render-context${level ? `?level=${level}` : ''}`,
    { headers: { 'x-billme-local-token': connection.token } },
  );
  const payload = await response.json() as { message?: string; document?: unknown; settings?: AppSettings | null; dunning?: { levelName: string } };
  if (!response.ok) throw new Error(payload.message ?? `Beleg konnte nicht geladen werden (HTTP ${response.status}).`);

  const { document } = toDesktopRenderContext({ document: serverRenderDocumentSchema.parse(payload.document) });
  const invoice = document as Invoice;
  const label = kind === 'offer' ? 'Angebot' : kind === 'dunning' ? payload.dunning?.levelName ?? 'Mahnung' : getInvoiceDocumentLabel(invoice.documentKind);
  const suggestedName = [label, invoice.number, invoice.client].filter(Boolean).join('-');

  const settings = payload.settings;
  if (kind !== 'invoice' || !settings?.eInvoice?.enabled || !isBillingDocumentKind(invoice.documentKind)) {
    return { suggestedName };
  }
  const xml = buildZugferdXml(normalizeInvoiceForEinvoice(invoice, settings));
  return {
    suggestedName,
    finalize: (pdf) => embedZugferdInPdf({ pdfBytes: pdf, xml, invoiceNumber: invoice.number }),
  };
};
