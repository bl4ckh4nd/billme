import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TaxFilingError, createTaxFilingRecord, transitionTaxFiling } from '@billme/accounting-engine';
import {
  taxFilingCreateRequestSchema,
  taxFilingMutationRequestSchema,
  taxFilingSchema,
  createTaxFilingService,
  TaxFilingServiceError,
  type TenantScope,
} from '@billme/server-core';
import {
  createPostgresAuditLogPort,
  createPostgresTaxFilingRepository,
  getReportSnapshot,
  listTaxCredentialMetadata,
  putEncryptedTaxCredential,
  encryptTaxFilingCredential,
  readTaxFilingCredentialKey,
  type ServerDatabase,
  type ServerDatabaseSession,
} from '@billme/server-data';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSessionFor, requireSession } from './runtimeContext.js';

const stateMachine = { create: createTaxFilingRecord, transition: transitionTaxFiling };

const idParams = z.object({ id: z.string().trim().min(1) });
const actionParams = idParams.extend({
  action: z.enum(['validate', 'freeze', 'request-second-approval', 'approve', 'queue', 'retry']),
});

const actionForPath = (action: z.infer<typeof actionParams>['action']) =>
  action === 'request-second-approval' ? 'request_second_approval' as const : action;

const toApiError = (error: unknown): never => {
  if (error instanceof TaxFilingError) {
    const status = error.code === 'INVALID_TRANSITION' || error.code === 'CONCURRENT_UPDATE' ? 409 : error.code === 'SELF_APPROVAL_FORBIDDEN' ? 403 : 422;
    throw new ApiError(status, error.message);
  }
  if (error instanceof TaxFilingServiceError) {
    throw new ApiError(error.code === 'INVALID_TRANSITION' || error.code === 'CONCURRENT_UPDATE' ? 409 : 422, error.message);
  }
  throw error;
};

const productMutationSession = async (app: FastifyInstance, product: 'lite' | 'pro', authHeader: string | undefined) => {
  return requireMutationSessionFor(app, product, authHeader, 'Tax filing mutation requires owner, admin, or accountant role');
};

const databaseFor = (app: FastifyInstance): ServerDatabase => requireDatabase(app);

const withTaxFilingTransaction = async <T>(
  app: FastifyInstance,
  work: (db: ServerDatabaseSession) => Promise<T>,
): Promise<T> => {
  return requireDatabase(app).transaction({ isolation: 'serializable' }, (session) => work(session));
};

const serviceFor = (app: FastifyInstance, db: ServerDatabase | ServerDatabaseSession = databaseFor(app)) => createTaxFilingService({
  repository: createPostgresTaxFilingRepository(db),
  stateMachine,
  auditLog: createPostgresAuditLogPort(db),
  reportSnapshot: { get: async (scope, id) => {
    const snapshot = await getReportSnapshot(db, scope, id);
    return snapshot ? { id: snapshot.id, tenantId: snapshot.tenantId, sourceHash: snapshot.sourceHash } : null;
  } },
});

const certificateIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const certificateSchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().min(1),
  subject: z.string().optional(),
});
const providerStatusSchema = z.object({
  available: z.boolean(),
  provider: z.literal('eric').nullable(),
  version: z.string().optional(),
  binaryPath: z.string().optional(),
  errorCode: z.enum(['PROVIDER_UNAVAILABLE', 'PROVIDER_INVALID']).optional(),
});
const taxFilingRecordMetadataSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['euer', 'e_bilanz', 'unternehmensregister']),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['frozen', 'approved', 'queued']),
});
const taxFilingOperationResultSchema = z.object({
  operation: z.enum(['validate', 'export', 'submit']),
  status: z.enum(['validated', 'exported', 'submitted', 'failed']),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputPath: z.string().optional(),
  issues: z.array(z.object({ code: z.string(), message: z.string(), field: z.string().optional() })),
});

type TaxCertificatePayload = {
  id: string;
  pem: string;
  password?: string;
  expiresAt: string;
  subject?: string;
};

const certificateKey = (id: string): string => `certificate:${id}`;
const certificateFingerprint = (pem: string): string => createHash('sha256').update(pem).digest('hex');
const credentialKeyForMutation = () => {
  try {
    return readTaxFilingCredentialKey();
  } catch {
    throw new ApiError(503, 'Tax filing credential encryption is not configured on this server');
  }
};
const certificateMetadata = (payload: TaxCertificatePayload, active: boolean) => ({
  certificateId: payload.id,
  fingerprint: certificateFingerprint(payload.pem),
  expiresAt: payload.expiresAt,
  ...(payload.subject ? { subject: payload.subject } : {}),
  active,
});

const parseCertificateMetadata = (value: string): ReturnType<typeof certificateMetadata> | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const metadata = parsed as Record<string, unknown>;
    if (
      typeof metadata.certificateId !== 'string'
      || typeof metadata.fingerprint !== 'string'
      || typeof metadata.expiresAt !== 'string'
      || typeof metadata.active !== 'boolean'
    ) return null;
    return {
      certificateId: metadata.certificateId,
      fingerprint: metadata.fingerprint,
      expiresAt: metadata.expiresAt,
      ...(typeof metadata.subject === 'string' ? { subject: metadata.subject } : {}),
      active: metadata.active,
    };
  } catch {
    return null;
  }
};

const listCertificates = async (app: FastifyInstance, scope: TenantScope) => {
  const records = await listTaxCredentialMetadata(databaseFor(app), scope, 'eric');
  const latest = new Map<string, ReturnType<typeof parseCertificateMetadata>>();
  for (const record of records) {
    if (!record.credentialKey.startsWith('certificate:') || latest.has(record.credentialKey)) continue;
    latest.set(record.credentialKey, parseCertificateMetadata(record.metadataJson));
  }
  return [...latest.values()]
    .filter((metadata): metadata is NonNullable<typeof metadata> => Boolean(metadata?.active))
    .map((metadata) => certificateSchema.parse({
      id: metadata.certificateId,
      fingerprint: metadata.fingerprint,
      expiresAt: metadata.expiresAt,
      ...(metadata.subject ? { subject: metadata.subject } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
};

export const registerTaxFilingRoutes = (app: FastifyInstance, product: 'lite' | 'pro' = 'pro'): void => {
  const prefix = `/api/v1/${product}/tax-filings`;

  typedRoute(app, {
    method: 'GET',
    url: prefix,
    response: z.array(taxFilingSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return serviceFor(app).list(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/:id`,
    params: idParams,
    response: taxFilingSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return serviceFor(app).get(session.scope, params.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: prefix,
    body: taxFilingCreateRequestSchema,
    response: taxFilingSchema,
    async handler({ request, body }) {
      const session = await productMutationSession(app, product, request.headers.authorization);
      const expectedProvider = body.kind === 'euer'
        ? 'eric_euer'
        : body.kind === 'e_bilanz'
          ? 'eric_e_bilanz'
          : 'unternehmensregister';
      if (body.provider && body.provider !== expectedProvider) {
        throw new ApiError(422, `Provider ${body.provider} cannot transmit ${body.kind}`);
      }
      try {
        return await withTaxFilingTransaction(app, async (client) => createTaxFilingService({
          repository: createPostgresTaxFilingRepository(client),
          stateMachine,
          auditLog: createPostgresAuditLogPort(client),
          reportSnapshot: { get: async (scope, id) => {
            const snapshot = await getReportSnapshot(client, scope, id);
            return snapshot ? { id: snapshot.id, tenantId: snapshot.tenantId, sourceHash: snapshot.sourceHash } : null;
          } },
        }).create(session.scope, {
          id: body.id,
          kind: body.kind,
          provider: body.provider,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          payload: body.payload,
          idempotencyKey: body.idempotencyKey,
          actorId: session.user.id,
          reason: body.reason,
        }));
      } catch (error) {
        return toApiError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/:id/:action`,
    params: actionParams,
    body: taxFilingMutationRequestSchema,
    response: taxFilingSchema,
    async handler({ request, params, body }) {
      const session = await productMutationSession(app, product, request.headers.authorization);
      try {
        return await withTaxFilingTransaction(app, async (client) => createTaxFilingService({
          repository: createPostgresTaxFilingRepository(client),
          stateMachine,
          auditLog: createPostgresAuditLogPort(client),
          reportSnapshot: { get: async (scope, id) => {
            const snapshot = await getReportSnapshot(client, scope, id);
            return snapshot ? { id: snapshot.id, tenantId: snapshot.tenantId, sourceHash: snapshot.sourceHash } : null;
          } },
        }).transition(session.scope, params.id, actionForPath(params.action), {
          actorId: session.user.id,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
        }));
      } catch (error) {
        return toApiError(error);
      }
    },
  });

  const operationsPrefix = `/api/v1/${product}/tax-filing`;

  typedRoute(app, {
    method: 'GET',
    url: `${operationsPrefix}/status`,
    response: z.object({ provider: providerStatusSchema, certificates: z.array(certificateSchema) }),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return {
        provider: { available: false as const, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' as const },
        certificates: await listCertificates(app, session.scope),
      };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${operationsPrefix}/records`,
    response: z.array(taxFilingRecordMetadataSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const records = await serviceFor(app).list(session.scope);
      return records
        .filter((record) => ['frozen', 'approved', 'queued'].includes(record.status))
        .map((record) => taxFilingRecordMetadataSchema.parse({
          id: record.id,
          kind: record.kind,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
          sourceHash: record.snapshotHash,
          status: record.status,
        }));
    },
  });

  const certificatePayloadSchema = z.object({
    id: certificateIdSchema,
    pem: z.string().trim().min(1).refine((value) => /^-----BEGIN [^-]+-----[\s\S]+-----END [^-]+-----$/.test(value), 'Invalid PEM certificate'),
    password: z.string().optional(),
    expiresAt: z.string().datetime(),
    subject: z.string().optional(),
    reason: z.string().trim().min(1).optional(),
  });

  typedRoute(app, {
    method: 'POST',
    url: `${operationsPrefix}/certificates`,
    body: certificatePayloadSchema,
    response: certificateSchema,
    async handler({ request, body }) {
      const session = await productMutationSession(app, product, request.headers.authorization);
      const key = credentialKeyForMutation();
      const payload: TaxCertificatePayload = {
        id: body.id,
        pem: body.pem,
        ...(body.password ? { password: body.password } : {}),
        expiresAt: body.expiresAt,
        ...(body.subject ? { subject: body.subject } : {}),
      };
      const metadata = certificateMetadata(payload, true);
      const envelope = encryptTaxFilingCredential({
        plaintext: JSON.stringify(payload),
        keyId: key.keyId,
        key: key.key,
      });
      await withTaxFilingTransaction(app, async (db) => {
        await putEncryptedTaxCredential(db, session.scope, {
          provider: 'eric',
          credentialKey: certificateKey(payload.id),
          encryptionAlgorithm: envelope.algorithm,
          keyVersion: envelope.keyId,
          metadataJson: JSON.stringify(metadata),
          encryptedBlob: new Uint8Array(Buffer.from(JSON.stringify(envelope))),
          createdBy: session.user.id,
        });
        await createPostgresAuditLogPort(db).append(session.scope, {
          occurredAt: new Date().toISOString(),
          action: 'tax_filing.certificate_install',
          reason: body.reason ?? 'Tax filing certificate installed',
          actor: createMutationContext(session, body.reason ?? 'Tax filing credential saved').actor,
          subject: { entityType: 'tax-filing-certificate', entityId: payload.id, tenantId: session.scope.tenantId },
          change: { before: null, after: { ...metadata, active: true } },
        });
      });
      return certificateSchema.parse({
        id: payload.id,
        fingerprint: metadata.fingerprint,
        expiresAt: payload.expiresAt,
        ...(payload.subject ? { subject: payload.subject } : {}),
      });
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${operationsPrefix}/certificates/:id`,
    params: z.object({ id: certificateIdSchema }),
    query: z.object({ reason: z.string().trim().min(1).optional() }),
    response: z.boolean(),
    async handler({ request, params, query }) {
      const session = await productMutationSession(app, product, request.headers.authorization);
      const existing = (await listCertificates(app, session.scope)).find((certificate) => certificate.id === params.id);
      if (!existing) return false;
      const key = credentialKeyForMutation();
      const metadata = {
        certificateId: existing.id,
        fingerprint: existing.fingerprint,
        expiresAt: existing.expiresAt,
        ...(existing.subject ? { subject: existing.subject } : {}),
        active: false,
      };
      const envelope = encryptTaxFilingCredential({
        plaintext: JSON.stringify({ id: existing.id, deleted: true }),
        keyId: key.keyId,
        key: key.key,
      });
      await withTaxFilingTransaction(app, async (db) => {
        await putEncryptedTaxCredential(db, session.scope, {
          provider: 'eric',
          credentialKey: certificateKey(existing.id),
          encryptionAlgorithm: envelope.algorithm,
          keyVersion: envelope.keyId,
          metadataJson: JSON.stringify(metadata),
          encryptedBlob: new Uint8Array(Buffer.from(JSON.stringify(envelope))),
          createdBy: session.user.id,
        });
        await createPostgresAuditLogPort(db).append(session.scope, {
          occurredAt: new Date().toISOString(),
          action: 'tax_filing.certificate_remove',
          reason: query.reason ?? 'Tax filing certificate removed',
          actor: createMutationContext(session, 'Tax filing certificate removed').actor,
          subject: { entityType: 'tax-filing-certificate', entityId: existing.id, tenantId: session.scope.tenantId },
          change: { before: existing, after: null },
        });
      });
      return true;
    },
  });

  const operationParams = z.object({ operation: z.enum(['validate', 'export', 'submit']) });
  const operationBody = z.object({ record: taxFilingRecordMetadataSchema });
  typedRoute(app, {
    method: 'POST',
    url: `${operationsPrefix}/:operation`,
    params: operationParams,
    body: operationBody,
    response: taxFilingOperationResultSchema,
    async handler({ request, params, body }) {
      const session = await productMutationSession(app, product, request.headers.authorization);
      const current = await serviceFor(app).get(session.scope, body.record.id);
      if (!current || current.snapshotHash !== body.record.sourceHash || current.kind !== body.record.kind || current.periodStart !== body.record.periodStart || current.periodEnd !== body.record.periodEnd) {
        throw new ApiError(409, 'Tax filing snapshot no longer matches the server record');
      }
      if (params.operation !== 'submit') {
        return {
          operation: params.operation,
          status: 'failed' as const,
          sourceHash: current.snapshotHash,
          issues: [{ code: 'PROVIDER_UNAVAILABLE', message: 'The official tax filing provider is not configured on this server.' }],
        };
      }
      try {
        const submitted = await withTaxFilingTransaction(app, (db) => serviceFor(app, db).submit(session.scope, current.id, {
          actorId: session.user.id,
          reason: 'Tax filing submitted through Billme',
          idempotencyKey: `http:tax-filing:submit:${current.id}:${current.snapshotHash}`,
        }));
        return {
          operation: 'submit' as const,
          status: submitted.status === 'accepted' ? 'submitted' as const : 'failed' as const,
          sourceHash: submitted.snapshotHash,
          issues: submitted.status === 'accepted' ? [] : [{ code: submitted.failureCode ?? 'PROVIDER_UNAVAILABLE', message: submitted.failureMessage ?? 'The official tax filing provider did not accept the filing.' }],
        };
      } catch (error) {
        return toApiError(error);
      }
    },
  });
};
