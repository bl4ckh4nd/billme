import { randomUUID } from 'node:crypto';
import {
  ensureDefaultProjectForClient,
  finalizeDocumentNumber,
  releaseDocumentNumber,
  reserveDocumentNumber,
  type AuditActor,
  type ClientProject,
  type DocumentNumberingPorts,
  type RecurringDomainDependencies,
  type RecurringNumberingSettingsShape,
  type TenantScope,
} from '@billme/server-core';
import type { ServerDatabase } from '../database.js';
import { createPostgresAuditLogPort } from './audit.js';
import {
  createPostgresClientRepository,
  createPostgresInvoiceRepository,
  createPostgresOfferRepository,
  createPostgresRecurringProfileRepository,
  getServerSettings,
  listServerNumberReservations,
  saveServerNumberReservation,
  saveServerSettings,
} from './billing.js';

type RecurringSettings = RecurringNumberingSettingsShape & Record<string, unknown>;

export interface ServerRecurringDependencyOptions {
  readonly actor?: AuditActor;
  readonly clock?: { now(): Date };
}

const nowIso = (clock: ServerRecurringDependencyOptions['clock']): string =>
  (clock ?? { now: () => new Date() }).now().toISOString();

/**
 * Persistence adapter for the recurring invoice module. Both HTTP and worker
 * adapters use this builder, so project filtering, numbering, settings and
 * transaction re-entry have one locality across Postgres and embedded PGlite.
 */
export const createServerRecurringDependencies = (
  database: ServerDatabase,
  scope: TenantScope,
  options: ServerRecurringDependencyOptions = {},
): RecurringDomainDependencies => {
  const clientRepository = () => createPostgresClientRepository(database);
  const invoiceRepository = () => createPostgresInvoiceRepository(database);
  const offerRepository = () => createPostgresOfferRepository(database);
  const profileRepository = () => createPostgresRecurringProfileRepository(database);
  const auditLog = createPostgresAuditLogPort(database);
  const readSettings = async (): Promise<{ settings: RecurringSettings; createdAt: string } | null> => {
    const record = await getServerSettings(database, scope.tenantId);
    if (!record) return null;
    return { settings: JSON.parse(record.settingsJson) as RecurringSettings, createdAt: record.createdAt };
  };

  const transaction = {
    inTransaction: <T>(work: () => Promise<T> | T): Promise<T> => database.transaction({}, async () => work()),
  };

  const saveSettings = async (settings: RecurringSettings): Promise<void> => {
    const current = await readSettings();
    const updatedAt = nowIso(options.clock);
    await saveServerSettings(database, {
      tenantId: scope.tenantId,
      settingsJson: JSON.stringify(settings),
      createdAt: current?.createdAt ?? updatedAt,
      updatedAt,
    });
  };

  const numbering: DocumentNumberingPorts<RecurringSettings> = {
    tx: transaction,
    getSettings: async () => (await readSettings())?.settings ?? null,
    saveSettings,
    createReservation: async (reservation) => {
      const stamp = nowIso(options.clock);
      await saveServerNumberReservation(database, {
        tenantId: scope.tenantId,
        ...reservation,
        createdAt: stamp,
        updatedAt: stamp,
      });
    },
    getReservationById: async (reservationId) => {
      const reservation = (await listServerNumberReservations(database, scope.tenantId))
        .find((entry) => entry.id === reservationId);
      return reservation ? {
        id: reservation.id,
        kind: reservation.kind,
        number: reservation.number,
        counterValue: reservation.counterValue,
        status: reservation.status,
        documentId: reservation.documentId,
      } : null;
    },
    updateReservation: async (reservation) => {
      const existing = (await listServerNumberReservations(database, scope.tenantId))
        .find((entry) => entry.id === reservation.id);
      const stamp = nowIso(options.clock);
      await saveServerNumberReservation(database, {
        tenantId: scope.tenantId,
        ...reservation,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      });
    },
    isNumberTaken: async (kind, number) => {
      if (kind === 'customer') {
        const clients = await clientRepository().list(scope);
        return clients.some((client) => client.customerNumber === number);
      }
      const documents = kind === 'invoice'
        ? await invoiceRepository().list(scope)
        : await offerRepository().list(scope);
      if (documents.some((document) => document.number === number)) return true;
      const reservations = await listServerNumberReservations(database, scope.tenantId);
      return reservations.some((reservation) => reservation.kind === kind
        && reservation.number === number && reservation.status !== 'released');
    },
    generateReservationId: async () => randomUUID(),
  };

  return {
    tx: transaction,
    recurringProfileStore: {
      list: (innerScope) => profileRepository().list(innerScope),
      getById: (innerScope, id) => profileRepository().getById(innerScope, id),
      getByIdForUpdate: (innerScope, id) => {
        const repository = profileRepository();
        return repository.getByIdForUpdate
          ? repository.getByIdForUpdate(innerScope, id)
          : repository.getById(innerScope, id);
      },
      save: (innerScope, profile) => profileRepository().save(innerScope, profile),
      remove: (innerScope, id) => profileRepository().remove(innerScope, id),
    },
    clientPort: { getById: (innerScope, id) => clientRepository().getById(innerScope, id) },
    invoicePort: { save: (innerScope, params) => invoiceRepository().save(innerScope, params.invoice) },
    numberingPort: {
      getSettings: async () => (await readSettings())?.settings ?? null,
      reserve: (kind, at) => reserveDocumentNumber(numbering, kind, at),
      release: (reservationId) => releaseDocumentNumber(numbering, reservationId),
      finalize: (reservationId, documentId) => finalizeDocumentNumber(numbering, reservationId, documentId),
    },
    projectPort: {
      ensureDefaultProject: async (clientId): Promise<ClientProject> => {
        const result = await ensureDefaultProjectForClient({
          tx: transaction,
          getActiveDefaultProjectForClient: async (id) => {
            const client = await clientRepository().getById(scope, id);
            return client?.projects.find((project) => project.name === 'Allgemein'
              && project.status === 'active' && !project.archivedAt) ?? null;
          },
          listProjectCodesByPrefix: async (prefix) => {
            const clients = await clientRepository().list(scope);
            return clients.flatMap((client) => client.projects
              .filter((project) => typeof project.code === 'string' && project.code.startsWith(prefix))
              .map((project) => project.code));
          },
          saveProject: async (project) => {
            const client = await clientRepository().getById(scope, project.clientId);
            if (!client) throw new Error(`Client ${project.clientId} not found`);
            const updatedAt = nowIso(options.clock);
            const nextProject = { ...project, createdAt: project.createdAt ?? updatedAt, updatedAt };
            await clientRepository().save(scope, {
              ...client,
              projects: [...client.projects.filter((entry) => entry.id !== nextProject.id), nextProject],
              updatedAt,
            });
            return nextProject;
          },
        }, { clientId, createProjectId: () => randomUUID() });

        if (result.created && options.actor) {
          await auditLog.append(scope, {
            occurredAt: nowIso(options.clock),
            action: 'project.create',
            reason: 'auto:default',
            actor: options.actor,
            subject: { entityType: 'project', entityId: result.project.id, tenantId: scope.tenantId },
            change: { before: null, after: result.project },
          });
        }
        return result.project;
      },
    },
    createInvoiceId: () => randomUUID(),
  };
};
