import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  authResponseSchema,
  authSessionInfoSchema,
  bootstrapRequestSchema,
  bootstrapStatusSchema,
  capabilitiesResponseSchema,
  clientSchema,
  healthResponseSchema,
  invoiceSchema,
  loginRequestSchema,
  offerSchema,
  recurringProfileSchema,
  serverApiSessionSchema,
  serverProductRoute,
  serverProductSchema,
  serverRoutes,
  type ServerProduct,
} from '@billme/server-core';
import { appSettingsSchema } from '@billme/desktop-contracts/schemas';
import {
  accountSchema,
  articleSchema,
  setActiveTemplatePayloadSchema,
  templateKindSchema,
  templateSchema,
} from '@billme/desktop-contracts-pro/schemas';

const productScopedDocumentKindSchema = z.enum(['invoice', 'offer']);

const okSchema = z.object({
  ok: z.literal(true),
});

const clientWriteSchema = clientSchema.omit({
  tenantId: true,
});

const invoiceWriteSchema = invoiceSchema.omit({
  tenantId: true,
});

const offerWriteSchema = offerSchema.omit({
  tenantId: true,
});

const recurringWriteSchema = recurringProfileSchema.omit({
  tenantId: true,
});

const invoiceCreateInputSchema = invoiceWriteSchema.extend({
  id: invoiceWriteSchema.shape.id.optional(),
  number: invoiceWriteSchema.shape.number.optional(),
  payments: invoiceWriteSchema.shape.payments.optional().default([]),
  history: invoiceWriteSchema.shape.history.optional().default([]),
});

const offerCreateInputSchema = offerWriteSchema.extend({
  id: offerWriteSchema.shape.id.optional(),
  number: offerWriteSchema.shape.number.optional(),
  history: offerWriteSchema.shape.history.optional().default([]),
});

const requestJsonErrorSchema = z.object({
  message: z.string().min(1),
});

export class BillmeServerClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly payload: unknown,
  ) {
    super(message);
  }
}

export type BillmeServerClientConfig = {
  baseUrl: string;
  product?: ServerProduct;
  token?: string | null;
  fetchImplementation?: typeof fetch;
};

const buildUrl = (
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
) => {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
};

const parseJsonResponse = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = requestJsonErrorSchema.safeParse(payload);
    throw new BillmeServerClientError(
      parsedError.success ? parsedError.data.message : `Request failed with status ${response.status}`,
      response.status,
      payload,
    );
  }
  return schema.parse(payload);
};

export const createBillmeServerClient = ({
  baseUrl,
  product = 'lite',
  token = null,
  fetchImplementation = fetch,
}: BillmeServerClientConfig) => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  const requestJson = async <T>(
    path: string,
    schema: z.ZodType<T>,
    options?: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      token?: string | null;
      query?: Record<string, string | number | boolean | null | undefined>;
    },
  ): Promise<T> => {
    const response = await fetchImplementation(buildUrl(normalizedBaseUrl, path, options?.query), {
      method: options?.method ?? 'GET',
      headers: {
        ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options?.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return parseJsonResponse(response, schema);
  };

  const requestText = async (
    path: string,
    options?: {
      token?: string | null;
      query?: Record<string, string | number | boolean | null | undefined>;
    },
  ): Promise<string> => {
    const response = await fetchImplementation(buildUrl(normalizedBaseUrl, path, options?.query), {
      method: 'GET',
      headers: options?.token ? { authorization: `Bearer ${options.token}` } : undefined,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const parsedError = requestJsonErrorSchema.safeParse(payload);
      throw new BillmeServerClientError(
        parsedError.success ? parsedError.data.message : `Request failed with status ${response.status}`,
        response.status,
        payload,
      );
    }
    return response.text();
  };

  const withProductPrefix = (path: string, nextProduct = product): string => serverProductRoute(nextProduct, path);

  const requireToken = (override?: string | null): string => {
    const resolved = override ?? token;
    if (!resolved) {
      throw new Error('A bearer token is required for this command.');
    }
    return resolved;
  };

  const createDocument = async (
    kind: 'invoice' | 'offer',
    args: {
      reason: string;
      document: z.input<typeof invoiceCreateInputSchema> | z.input<typeof offerCreateInputSchema>;
      product?: ServerProduct;
      token?: string | null;
    },
  ) => {
    const nextProduct = args.product ?? product;
    const nextToken = requireToken(args.token);
    const reservation =
      typeof (args.document as { number?: string }).number === 'string'
        ? null
        : await requestJson(
            withProductPrefix('/numbers/reserve', nextProduct),
            z.object({
              reservationId: z.string().min(1),
              number: z.string().min(1),
            }),
            {
              method: 'POST',
              token: nextToken,
              body: {
                kind,
              },
            },
          );

    try {
      if (kind === 'invoice') {
        const parsed = invoiceCreateInputSchema.parse(args.document);
        const saved = await requestJson(withProductPrefix('/invoices', nextProduct), invoiceSchema, {
          method: 'POST',
          token: nextToken,
          body: {
            reason: args.reason,
            invoice: invoiceWriteSchema.parse({
              ...parsed,
              id: parsed.id ?? randomUUID(),
              number: parsed.number ?? reservation?.number,
              payments: parsed.payments ?? [],
              history: parsed.history ?? [],
            }),
          },
        });
        if (reservation) {
          await requestJson(withProductPrefix('/numbers/finalize', nextProduct), okSchema, {
            method: 'POST',
            token: nextToken,
            body: {
              reservationId: reservation.reservationId,
              documentId: saved.id,
            },
          });
        }
        return saved;
      }

      const parsed = offerCreateInputSchema.parse(args.document);
      const saved = await requestJson(withProductPrefix('/offers', nextProduct), offerSchema, {
        method: 'POST',
        token: nextToken,
        body: {
          reason: args.reason,
          offer: offerWriteSchema.parse({
            ...parsed,
            id: parsed.id ?? randomUUID(),
            number: parsed.number ?? reservation?.number,
            history: parsed.history ?? [],
          }),
        },
      });
      if (reservation) {
        await requestJson(withProductPrefix('/numbers/finalize', nextProduct), okSchema, {
          method: 'POST',
          token: nextToken,
          body: {
            reservationId: reservation.reservationId,
            documentId: saved.id,
          },
        });
      }
      return saved;
    } catch (error) {
      if (reservation) {
        await requestJson(withProductPrefix('/numbers/release', nextProduct), okSchema, {
          method: 'POST',
          token: nextToken,
          body: {
            reservationId: reservation.reservationId,
          },
        }).catch(() => undefined);
      }
      throw error;
    }
  };

  return {
    getHealth() {
      return requestJson(serverRoutes.health, healthResponseSchema);
    },
    getCapabilities() {
      return requestJson(serverRoutes.meta.capabilities, capabilitiesResponseSchema);
    },
    getBootstrapStatus(nextProduct = product) {
      return requestJson(serverRoutes.auth.bootstrapStatus, bootstrapStatusSchema, {
        query: {
          product: nextProduct,
        },
      });
    },
    bootstrap(input: z.input<typeof bootstrapRequestSchema>, nextProduct = product) {
      return requestJson(serverRoutes.auth.bootstrap, authResponseSchema, {
        method: 'POST',
        query: {
          product: nextProduct,
        },
        body: bootstrapRequestSchema.parse(input),
      });
    },
    login(input: z.input<typeof loginRequestSchema>, nextProduct = product) {
      return requestJson(serverRoutes.auth.login, authResponseSchema, {
        method: 'POST',
        query: {
          product: nextProduct,
        },
        body: loginRequestSchema.parse(input),
      });
    },
    getSessionInfo(options?: {
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = options?.product ?? product;
      return requestJson(serverRoutes.auth.me, authSessionInfoSchema, {
        query: {
          product: nextProduct,
        },
        token: requireToken(options?.token),
      });
    },
    async ensureSession(input: z.input<typeof bootstrapRequestSchema> & { product?: ServerProduct }) {
      const nextProduct = input.product ?? product;
      const status = await this.getBootstrapStatus(nextProduct);
      const authResponse = status.bootstrapped
        ? await this.login(input, nextProduct)
        : await this.bootstrap(input, nextProduct);
      const sessionInfo = await this.getSessionInfo({
        product: nextProduct,
        token: authResponse.token,
      });
      return serverApiSessionSchema.parse({
        ...authResponse,
        tenantId: sessionInfo.tenantId,
        product: sessionInfo.product,
        role: sessionInfo.role,
        via: status.bootstrapped ? 'login' : 'bootstrap',
      });
    },
    listClients(options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix('/clients', options?.product ?? product), z.array(clientSchema), {
        token: requireToken(options?.token),
      });
    },
    getClient(id: string, options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix(`/clients/${encodeURIComponent(id)}`, options?.product ?? product), clientSchema.nullable(), {
        token: requireToken(options?.token),
      });
    },
    upsertClient(args: {
      reason: string;
      client: z.input<typeof clientWriteSchema>;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix('/clients', nextProduct), clientSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
          client: clientWriteSchema.parse(args.client),
        },
      });
    },
    deleteClient(args: { id: string; reason: string; product?: ServerProduct; token?: string | null }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix(`/clients/${encodeURIComponent(args.id)}`, nextProduct), okSchema, {
        method: 'DELETE',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
        },
      });
    },
    listInvoices(options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix('/invoices', options?.product ?? product), z.array(invoiceSchema), {
        token: requireToken(options?.token),
      });
    },
    getInvoice(id: string, options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix(`/invoices/${encodeURIComponent(id)}`, options?.product ?? product), invoiceSchema.nullable(), {
        token: requireToken(options?.token),
      });
    },
    upsertInvoice(args: {
      reason: string;
      invoice: z.input<typeof invoiceWriteSchema>;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix('/invoices', nextProduct), invoiceSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
          invoice: invoiceWriteSchema.parse(args.invoice),
        },
      });
    },
    createInvoice(args: {
      reason: string;
      invoice: z.input<typeof invoiceCreateInputSchema>;
      product?: ServerProduct;
      token?: string | null;
    }) {
      return createDocument('invoice', {
        reason: args.reason,
        document: args.invoice,
        product: args.product,
        token: args.token,
      });
    },
    deleteInvoice(args: { id: string; reason: string; product?: ServerProduct; token?: string | null }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix(`/invoices/${encodeURIComponent(args.id)}`, nextProduct), okSchema, {
        method: 'DELETE',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
        },
      });
    },
    listOffers(options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix('/offers', options?.product ?? product), z.array(offerSchema), {
        token: requireToken(options?.token),
      });
    },
    getOffer(id: string, options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix(`/offers/${encodeURIComponent(id)}`, options?.product ?? product), offerSchema.nullable(), {
        token: requireToken(options?.token),
      });
    },
    upsertOffer(args: {
      reason: string;
      offer: z.input<typeof offerWriteSchema>;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix('/offers', nextProduct), offerSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
          offer: offerWriteSchema.parse(args.offer),
        },
      });
    },
    createOffer(args: {
      reason: string;
      offer: z.input<typeof offerCreateInputSchema>;
      product?: ServerProduct;
      token?: string | null;
    }) {
      return createDocument('offer', {
        reason: args.reason,
        document: args.offer,
        product: args.product,
        token: args.token,
      });
    },
    deleteOffer(args: { id: string; reason: string; product?: ServerProduct; token?: string | null }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix(`/offers/${encodeURIComponent(args.id)}`, nextProduct), okSchema, {
        method: 'DELETE',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
        },
      });
    },
    listRecurringProfiles(options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix('/recurring', options?.product ?? product), z.array(recurringProfileSchema), {
        token: requireToken(options?.token),
      });
    },
    getRecurringProfile(id: string, options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(
        withProductPrefix(`/recurring/${encodeURIComponent(id)}`, options?.product ?? product),
        recurringProfileSchema.nullable(),
        {
          token: requireToken(options?.token),
        },
      );
    },
    upsertRecurringProfile(args: {
      reason: string;
      profile: z.input<typeof recurringWriteSchema>;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix('/recurring', nextProduct), recurringProfileSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
          profile: recurringWriteSchema.parse(args.profile),
        },
      });
    },
    deleteRecurringProfile(args: { id: string; reason: string; product?: ServerProduct; token?: string | null }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix(`/recurring/${encodeURIComponent(args.id)}`, nextProduct), okSchema, {
        method: 'DELETE',
        token: requireToken(args.token),
        body: {
          reason: z.string().min(1).parse(args.reason),
        },
      });
    },
    getSettings(options?: { product?: ServerProduct; token?: string | null }) {
      return requestJson(withProductPrefix('/settings', options?.product ?? product), appSettingsSchema.nullable(), {
        token: requireToken(options?.token),
      });
    },
    setSettings(args: {
      settings: z.input<typeof appSettingsSchema>;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix('/settings', nextProduct), okSchema, {
        method: 'PUT',
        token: requireToken(args.token),
        body: {
          settings: appSettingsSchema.parse(args.settings),
        },
      });
    },
    reserveNumber(args: {
      kind: 'invoice' | 'offer' | 'customer';
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(
        withProductPrefix('/numbers/reserve', nextProduct),
        z.object({
          reservationId: z.string().min(1),
          number: z.string().min(1),
        }),
        {
          method: 'POST',
          token: requireToken(args.token),
          body: {
            kind: z.enum(['invoice', 'offer', 'customer']).parse(args.kind),
          },
        },
      );
    },
    releaseNumber(args: {
      reservationId: string;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix('/numbers/release', nextProduct), okSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          reservationId: z.string().min(1).parse(args.reservationId),
        },
      });
    },
    finalizeNumber(args: {
      reservationId: string;
      documentId: string;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(withProductPrefix('/numbers/finalize', nextProduct), okSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          reservationId: z.string().min(1).parse(args.reservationId),
          documentId: z.string().min(1).parse(args.documentId),
        },
      });
    },
    getDocument(args: {
      kind: 'invoice' | 'offer';
      id: string;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(
        withProductPrefix(
          `/documents/${productScopedDocumentKindSchema.parse(args.kind)}/${encodeURIComponent(args.id)}`,
          nextProduct,
        ),
        z.union([invoiceSchema, offerSchema]).nullable(),
        {
          token: requireToken(args.token),
        },
      );
    },
    exportDocumentJson(args: {
      kind: 'invoice' | 'offer';
      id: string;
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestJson(
        withProductPrefix(
          `/documents/${productScopedDocumentKindSchema.parse(args.kind)}/${encodeURIComponent(args.id)}/export.json`,
          nextProduct,
        ),
        z.union([invoiceSchema, offerSchema]),
        {
          token: requireToken(args.token),
        },
      );
    },
    exportDocumentsCsv(args: {
      kind: 'invoice' | 'offer';
      product?: ServerProduct;
      token?: string | null;
    }) {
      const nextProduct = args.product ?? product;
      return requestText(withProductPrefix('/documents/export.csv', nextProduct), {
        query: {
          kind: productScopedDocumentKindSchema.parse(args.kind),
        },
        token: requireToken(args.token),
      });
    },
    listArticles(options?: { token?: string | null }) {
      return requestJson(serverRoutes.pro.articles, z.array(articleSchema), {
        token: requireToken(options?.token),
      });
    },
    upsertArticle(args: {
      article: z.input<typeof articleSchema>;
      token?: string | null;
    }) {
      return requestJson(serverRoutes.pro.articles, articleSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          article: articleSchema.parse(args.article),
        },
      });
    },
    listAccounts(options?: { token?: string | null }) {
      return requestJson(serverRoutes.pro.accounts, z.array(accountSchema), {
        token: requireToken(options?.token),
      });
    },
    upsertAccount(args: {
      account: z.input<typeof accountSchema>;
      token?: string | null;
    }) {
      return requestJson(serverRoutes.pro.accounts, accountSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          account: accountSchema.parse(args.account),
        },
      });
    },
    listTemplates(args?: { kind?: 'invoice' | 'offer'; token?: string | null }) {
      return requestJson(serverRoutes.pro.templates.list, z.array(templateSchema), {
        token: requireToken(args?.token),
        query: args?.kind
          ? {
              kind: templateKindSchema.parse(args.kind),
            }
          : undefined,
      });
    },
    upsertTemplate(args: {
      template: z.input<typeof templateSchema>;
      token?: string | null;
    }) {
      return requestJson(serverRoutes.pro.templates.list, templateSchema, {
        method: 'POST',
        token: requireToken(args.token),
        body: {
          template: templateSchema.parse(args.template),
        },
      });
    },
    getActiveTemplate(args: {
      kind: 'invoice' | 'offer';
      token?: string | null;
    }) {
      return requestJson(
        serverRoutes.pro.templates.activeByKind(templateKindSchema.parse(args.kind)),
        templateSchema.nullable(),
        {
          token: requireToken(args.token),
        },
      );
    },
    setActiveTemplate(args: {
      kind: 'invoice' | 'offer';
      templateId?: string | null;
      token?: string | null;
    }) {
      return requestJson(serverRoutes.pro.templates.active, okSchema, {
        method: 'PUT',
        token: requireToken(args.token),
        body: setActiveTemplatePayloadSchema.parse({
          kind: args.kind,
          templateId: args.templateId ?? undefined,
        }),
      });
    },
  };
};

export type BillmeServerClient = ReturnType<typeof createBillmeServerClient>;

export {
  accountSchema,
  appSettingsSchema,
  articleSchema,
  clientWriteSchema,
  invoiceCreateInputSchema,
  invoiceWriteSchema,
  offerCreateInputSchema,
  offerWriteSchema,
  recurringWriteSchema,
  templateSchema,
};
