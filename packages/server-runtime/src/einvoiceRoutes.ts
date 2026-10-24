import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { einvoiceParseRequestSchema, incomingEinvoiceSchema, xrechnungExportSchema } from '@billme/server-core';
import { EinvoiceRequestError, buildXRechnungFromRenderContext } from '@billme/desktop-services/einvoice/xrechnung';
import { parseIncomingEinvoice } from '@billme/desktop-services/einvoice/parseIncomingEinvoice';
import { loadRenderContext } from './documentTemplateRoutes.js';
import { typedRoute } from './http.js';
import { requireSession } from './runtimeContext.js';

/** Reading received e-invoices and exporting XRechnung, for Lite and Pro alike. */
export const registerEinvoiceRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/einvoice/parse`,
    body: einvoiceParseRequestSchema,
    bodyLimit: 20_000_000,
    response: incomingEinvoiceSchema,
    async handler({ request, body }) {
      await requireSession(app, product, request.headers.authorization);
      const bytes = Buffer.from(body.contentBase64, 'base64');
      if (bytes.toString('base64') !== body.contentBase64.replace(/\s/g, '')) throw new EinvoiceRequestError('Der Dateiinhalt ist kein gültiges Base64.', 400);
      return parseIncomingEinvoice(new Uint8Array(bytes), body.fileName);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/documents/invoice/:id/xrechnung`,
    params: z.object({ id: z.string().min(1) }),
    response: xrechnungExportSchema,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const context = await loadRenderContext(app, session, { kind: 'invoice', id: params.id }, {});
      const { fileName, xml } = buildXRechnungFromRenderContext(context);
      return { fileName, mimeType: 'application/xml' as const, contentBase64: Buffer.from(xml, 'utf8').toString('base64') };
    },
  });
};
