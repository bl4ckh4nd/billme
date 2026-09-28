import { z } from 'zod';
import { invoiceSchema, offerSchema } from '@billme/server-core';
import { toLegacyInvoice, toLegacyOffer } from './billingDomainMappers';

/** The server answers with the domain document; the renderer works on the legacy shape. */
export const serverRenderDocumentSchema = z.discriminatedUnion('kind', [invoiceSchema, offerSchema]);

export const toDesktopRenderContext = <T extends { document: z.output<typeof serverRenderDocumentSchema> }>(context: T) => ({
  ...context,
  document: context.document.kind === 'offer' ? toLegacyOffer(context.document) : toLegacyInvoice(context.document),
});
