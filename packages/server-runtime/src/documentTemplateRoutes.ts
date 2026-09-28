import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  documentTemplateBodySchema,
  documentTemplateDefaultsSchema,
  documentTemplateRecordSchema,
  invoiceSchema,
  offerSchema,
  buildDunningDocumentContext,
  resolveDocumentTemplate,
  templateKindForDocument,
  templateKindSchema,
  type DocumentTemplateBody,
  type TemplateKind,
} from '@billme/server-core';
import {
  createPostgresBillingDependencies,
  deleteServerDocumentTemplate,
  getServerDocumentTemplateDefaults,
  getServerDocumentTemplateVersion,
  getServerSettings,
  listServerDocumentTemplates,
  saveServerDocumentTemplate,
  saveServerDocumentTemplateDefault,
  type ServerDocumentTemplateRecord,
} from '@billme/server-data';
import { appSettingsSchema } from '@billme/desktop-contracts-pro/schemas';
import { ApiError, typedRoute } from './http.js';
import { requireDatabase, requireMutationSessionFor, requireSession } from './runtimeContext.js';

const okSchema = z.object({ ok: z.literal(true) });

const upsertBodySchema = z.object({
  template: z.object({
    id: z.string().min(1).optional(),
    kind: templateKindSchema,
    name: z.string().trim().min(1).max(120),
    body: documentTemplateBodySchema,
  }),
});

export const renderContextSchema = z.object({
  templateKind: templateKindSchema,
  document: z.discriminatedUnion('kind', [invoiceSchema, offerSchema]),
  template: z.object({
    id: z.string().optional(),
    version: z.number().int().positive().optional(),
    name: z.string().optional(),
    body: documentTemplateBodySchema,
  }),
  settings: appSettingsSchema.nullable(),
  source: z.object({
    number: z.string(),
    date: z.string(),
    documentKind: invoiceSchema.shape.documentKind,
  }).optional(),
  /** Text overrides the letter prints with (document layout, or the dunning level's text). */
  texts: z.object({ intro: z.string().optional(), closing: z.string().optional() }).optional(),
  dunning: z.object({
    level: z.number().int(),
    levelName: z.string(),
    date: z.string(),
    payUntil: z.string(),
    fee: z.number(),
    originalAmount: z.number(),
    paidAmount: z.number(),
    daysOverdue: z.number().int(),
  }).optional(),
});

const toRecord = (record: ServerDocumentTemplateRecord) => documentTemplateRecordSchema.parse({
  id: record.id,
  kind: record.kind,
  name: record.name,
  version: record.version,
  body: JSON.parse(record.bodyJson),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export const registerDocumentTemplateRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/document-templates`,
    query: z.object({ kind: templateKindSchema.optional() }),
    response: z.array(documentTemplateRecordSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const records = await listServerDocumentTemplates(requireDatabase(app), session.scope.tenantId);
      return records.filter((record) => !query.kind || record.kind === query.kind).map(toRecord);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-templates`,
    body: upsertBodySchema,
    response: documentTemplateRecordSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      try {
        const saved = await saveServerDocumentTemplate(requireDatabase(app), {
          id: body.template.id ?? randomUUID(),
          tenantId: session.scope.tenantId,
          kind: body.template.kind,
          name: body.template.name,
          bodyJson: JSON.stringify(body.template.body),
        });
        return toRecord(saved);
      } catch (error) {
        throw new ApiError(409, error instanceof Error ? error.message : String(error));
      }
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/document-templates/:id`,
    params: z.object({ id: z.string().min(1) }),
    response: okSchema,
    async handler({ request, params }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      await deleteServerDocumentTemplate(requireDatabase(app), session.scope.tenantId, params.id);
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/document-templates/defaults`,
    response: documentTemplateDefaultsSchema,
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return getServerDocumentTemplateDefaults(requireDatabase(app), session.scope.tenantId);
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/document-templates/defaults`,
    body: z.object({ kind: templateKindSchema, templateId: z.string().min(1).nullable() }),
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      if (body.templateId) {
        const template = (await listServerDocumentTemplates(database, session.scope.tenantId))
          .find((record) => record.id === body.templateId);
        if (!template || template.kind !== body.kind) {
          throw new ApiError(404, 'Vorlage für diese Belegart nicht gefunden.');
        }
      }
      await saveServerDocumentTemplateDefault(database, session.scope.tenantId, body.kind, body.templateId);
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/documents/:kind/:id/render-context`,
    params: z.object({ kind: z.enum(['invoice', 'offer', 'dunning']), id: z.string().min(1) }),
    query: z.object({ level: z.coerce.number().int().positive().optional() }),
    response: renderContextSchema,
    async handler({ request, params, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      const tenantId = session.scope.tenantId;
      const repositories = createPostgresBillingDependencies(database);
      const document = params.kind === 'offer'
        ? await repositories.offerRepo.getById(session.scope, params.id)
        : await repositories.invoiceRepo.getById(session.scope, params.id);
      if (!document) throw new ApiError(404, 'Beleg nicht gefunden.');

      // A dunning letter is a new document about the invoice: current template and company data.
      const isDunning = params.kind === 'dunning';
      if (isDunning && document.kind !== 'invoice') throw new ApiError(404, 'Rechnung nicht gefunden.');
      const templateKind: TemplateKind = isDunning
        ? 'dunning'
        : document.kind === 'offer' ? 'offer' : templateKindForDocument({ documentKind: document.documentKind });
      const storedSettings = await getServerSettings(database, tenantId);
      let settings = storedSettings ? appSettingsSchema.parse(JSON.parse(storedSettings.settingsJson)) : null;

      // Resolution order: frozen snapshot → per-document choice → default of the kind → preset.
      let template: { id?: string; version?: number; name?: string; body: DocumentTemplateBody } | null = null;
      const snapshot = isDunning ? undefined : document.layout?.snapshot;
      if (snapshot) {
        const version = await getServerDocumentTemplateVersion(database, tenantId, snapshot.templateId, snapshot.templateVersion);
        if (version) {
          template = { id: snapshot.templateId, version: snapshot.templateVersion, body: documentTemplateBodySchema.parse(JSON.parse(version.bodyJson)) };
        }
        if (settings) settings = appSettingsSchema.parse({ ...settings, ...snapshot.sender });
      }
      if (!template) {
        const records = await listServerDocumentTemplates(database, tenantId);
        template = resolveDocumentTemplate(templateKind, {
          templateId: document.layout?.templateId,
          templates: records.filter((record) => record.kind === templateKind).map(toRecord),
          defaults: await getServerDocumentTemplateDefaults(database, tenantId),
        });
      }

      let source: z.infer<typeof renderContextSchema>['source'];
      if (document.kind === 'invoice' && templateKind === 'credit_note' && document.sourceDocumentId) {
        const sourceInvoice = await repositories.invoiceRepo.getById(session.scope, document.sourceDocumentId);
        if (sourceInvoice) {
          source = { number: sourceInvoice.number, date: sourceInvoice.date, documentKind: sourceInvoice.documentKind };
        }
      }

      if (document.kind === 'invoice' && isDunning) {
        const { intro, ...dunning } = buildDunningDocumentContext({
          invoice: document,
          level: query.level,
          levels: settings?.dunning.levels ?? [],
          history: await repositories.dunningHistoryRepo.listByInvoice(session.scope, document.id),
          today: new Date(),
        });
        return { templateKind, document, template, settings, source, dunning, texts: intro ? { intro } : undefined };
      }
      return { templateKind, document, template, settings, source, texts: document.layout?.texts };
    },
  });
};
