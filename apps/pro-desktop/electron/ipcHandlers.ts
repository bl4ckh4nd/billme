import { dialog, shell, type BrowserWindow, type IpcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import type { DocumentTemplateKind, Invoice } from '../types';
import { logger } from '../utils/logger';
import { closeDb, getDb, getDbPath, initDb } from '../db/connection';
import { createInvoiceFromOffer, deleteInvoice, listInvoices, upsertInvoice } from '../db/invoicesRepo';
import {
  deleteOffer,
  getOffer,
  listOffers,
  publishOfferToPortal,
  syncPublishedOfferDecisionFromPortal,
  upsertOffer,
} from '../db/offersRepo';
import { deleteClient, getClient, listClients, upsertClient } from '../db/clientsRepo';
import {
  archiveProject,
  ensureDefaultProjectForClient,
  getProject,
  listProjects,
  upsertProject,
} from '../db/projectsRepo';
import { deleteArticle, listArticles, upsertArticle } from '../db/articlesRepo';
import { deleteAccount, listAccounts, upsertAccount } from '../db/accountsRepo';
import { deleteRecurringProfile, listRecurringProfiles, upsertRecurringProfile } from '../db/recurringRepo';
import { getSettings, setSettings } from '../db/settingsRepo';
import { getInvoice } from '../db/invoicesRepo';
import { finalizeNumber, releaseNumber, reserveNumber } from '../db/numberingRepo';
import {
  deleteTemplate,
  getActiveTemplate,
  listTemplates,
  setActiveTemplateId,
  upsertTemplate,
} from '../db/templatesRepo';
import { exportAuditCsv, verifyAuditChain } from '../db/audit';
import { backupSqlite, ensureDir } from '../db/backup';
import { secrets } from './secrets';
import { formatAddressMultiline } from '../utils/formatters';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '../ipc/contract';
import { portalClient } from '../services/portalClient';
import crypto from 'crypto';
import { exportPdf, exportEurPdf } from './pdfExport';
import { commitCsv, previewCsv } from '../services/csvImport';
import {
  createImportBatch,
  insertTransactionsIgnoringDuplicates,
  listImportBatches,
  getImportBatchDetails,
  rollbackImportBatch,
} from '../db/financeImportRepo';
import type { AppSettings } from '../types';
import { sendEmail, testEmailConfig, type SmtpConfig, type ResendConfig, type EmailOptions } from '../services/emailService';
import { logEmail } from '../db/emailRepo';
import {
  getUnmatchedTransactions,
  findInvoiceMatches,
  linkTransactionToInvoice,
  unlinkTransactionFromInvoice,
  listTransactions,
} from '../db/transactionsRepo';
import { manualDunningRun } from './dunningScheduler';
import { manualRecurringRun } from './recurringScheduler';
import { getCurrentUpdateStatus, downloadUpdate, quitAndInstall } from './updater';
import { getInvoiceDunningStatus } from '../services/dunningService';
import { buildEurCsv, getEurReport, listEurItems, upsertEurItemClassification } from '../services/eurReport';
import { listAllEurRules, upsertEurRule, deleteEurRule } from '../db/eurRulesRepo';
import {
  bindProAccountingFacadeScope,
  createProAccountingFacade,
} from '@billme/accounting-engine';
import {
  buildZugferdXml,
  calculateInvoiceTaxSnapshot,
  embedZugferdInPdf,
  normalizeInvoiceForEinvoice,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';
import { PRODUCT_PROFILE } from '../productProfile';
import { importSkrCharts } from '../services/skrImport';
import {
  createSqliteProAccountingCatalogRepository,
  createSqliteProAccountingRepository,
  createSqliteProWorkflowRepository,
} from '../db/proAccountingPorts';
import { buildDatevBuchungsstapelCsv } from '../services/datevExport';
import { buildTaxAuditExportPackage } from '../services/auditExportPackage';
import { seedAccountKeywords } from '../services/accountKeywordSeed';
import { resolveRuntimeProTenantScope } from '../tenantScope';

const normalizeInvoiceTaxData = (doc: Invoice, settings: AppSettings): Invoice => {
  const taxMode = resolveInvoiceTaxMode(doc.taxMode, settings);
  const taxSnapshot = calculateInvoiceTaxSnapshot(
    {
      items: doc.items ?? [],
      taxMode,
      taxMeta: doc.taxMeta,
    },
    settings,
  );
  return {
    ...doc,
    taxMode,
    taxSnapshot,
    amount: taxSnapshot.grossAmount,
  };
};

const deriveCustomerRef = (doc: Invoice): string => {
  if (doc.clientId && doc.clientId.trim()) return `client:${doc.clientId.trim()}`;
  if (doc.clientEmail && doc.clientEmail.trim()) {
    return `email:${crypto.createHash('sha256').update(doc.clientEmail.trim().toLowerCase()).digest('hex')}`;
  }
  return `anon:${crypto.createHash('sha256').update(doc.id).digest('hex').slice(0, 16)}`;
};

const requireSettings = (db: Database.Database): AppSettings => {
  const settings = getSettings(db);
  if (!settings) {
    throw new Error(
      'Einstellungen nicht konfiguriert. Bitte öffnen Sie die Einstellungen und speichern Sie diese.'
    );
  }
  return settings;
};

type ProActorRole = 'bookkeeper' | 'reviewer' | 'accountant' | 'admin' | 'auditor';

const assertProRoleAllowed = (action: string, actorRole: ProActorRole, allowed: ProActorRole[]): void => {
  if (allowed.includes(actorRole)) return;
  throw new Error(`Unauthorized for ${action}: role "${actorRole}" is not permitted.`);
};

type DbProvider = () => Database.Database;
type UserDataProvider = () => string;

type RouteHandler<K extends IpcRouteKey> = (
  args: IpcArgs<K>,
) => Promise<IpcResult<K>> | IpcResult<K>;

const register = <K extends IpcRouteKey>(ipcMain: IpcMain, key: K, fn: RouteHandler<K>) => {
  const route = ipcRoutes[key];
  ipcMain.handle(route.channel, async (_evt, rawArgs) => {
    const args = route.args.parse(rawArgs) as IpcArgs<K>;
    const result = await fn(args);
    return route.result.parse(result) as IpcResult<K>;
  });
};

export const registerIpcHandlers = (
  ipcMain: IpcMain,
  deps: {
    requireDb: DbProvider;
    getUserDataPath: UserDataProvider;
    getMainWindow: () => BrowserWindow | null;
  },
) => {
  const requireDb = deps.requireDb;
  const getUserDataPath = deps.getUserDataPath;
  const getMainWindow = deps.getMainWindow;
  const getProScope = () => resolveRuntimeProTenantScope();
  const getProAccountingFacade = () => {
    const db = requireDb();
    return bindProAccountingFacadeScope(
      createProAccountingFacade({
        accounting: createSqliteProAccountingRepository(db),
        catalog: createSqliteProAccountingCatalogRepository(db),
        workflow: createSqliteProWorkflowRepository(db),
      }),
      getProScope(),
    );
  };

  register(ipcMain, 'invoices:list', () => {
    const db = requireDb();
    return listInvoices(db);
  });

  register(ipcMain, 'invoices:upsert', ({ invoice, reason }) => {
    const db = requireDb();
    const settings = requireSettings(db);
    const computed = normalizeInvoiceTaxData(invoice, settings);
    return upsertInvoice(db, computed, reason);
  });

  register(ipcMain, 'invoices:delete', ({ id, reason }) => {
    const db = requireDb();
    deleteInvoice(db, id, reason);
    return { ok: true };
  });

  register(ipcMain, 'offers:list', () => {
    const db = requireDb();
    return listOffers(db);
  });

  register(ipcMain, 'offers:upsert', ({ offer, reason }) => {
    const db = requireDb();
    const settings = requireSettings(db);
    const computed = normalizeInvoiceTaxData(offer, settings);
    return upsertOffer(db, computed, reason);
  });

  register(ipcMain, 'offers:delete', ({ id, reason }) => {
    const db = requireDb();
    deleteOffer(db, id, reason);
    return { ok: true };
  });

  register(ipcMain, 'clients:list', () => {
    const db = requireDb();
    return listClients(db);
  });

  register(ipcMain, 'clients:upsert', ({ client }) => {
    const db = requireDb();
    return upsertClient(db, client);
  });

  register(ipcMain, 'clients:delete', ({ id }) => {
    const db = requireDb();
    deleteClient(db, id);
    return { ok: true };
  });

  register(ipcMain, 'projects:list', ({ clientId, includeArchived }) => {
    const db = requireDb();
    return listProjects(db, { clientId, includeArchived });
  });

  register(ipcMain, 'projects:get', ({ id }) => {
    const db = requireDb();
    return getProject(db, id);
  });

  register(ipcMain, 'projects:upsert', ({ project, reason }) => {
    const db = requireDb();
    return upsertProject(db, project, reason);
  });

  register(ipcMain, 'projects:archive', ({ id, reason }) => {
    const db = requireDb();
    return archiveProject(db, id, reason);
  });

  register(ipcMain, 'articles:list', () => {
    const db = requireDb();
    return listArticles(db);
  });

  register(ipcMain, 'articles:upsert', ({ article }) => {
    const db = requireDb();
    return upsertArticle(db, article);
  });

  register(ipcMain, 'articles:delete', ({ id }) => {
    const db = requireDb();
    deleteArticle(db, id);
    return { ok: true };
  });

  register(ipcMain, 'accounts:list', () => {
    const db = requireDb();
    return listAccounts(db);
  });

  register(ipcMain, 'accounts:upsert', ({ account }) => {
    const db = requireDb();
    return upsertAccount(db, account);
  });

  register(ipcMain, 'accounts:delete', ({ id }) => {
    const db = requireDb();
    deleteAccount(db, id);
    return { ok: true };
  });

  register(ipcMain, 'recurring:list', () => {
    const db = requireDb();
    return listRecurringProfiles(db);
  });

  register(ipcMain, 'recurring:upsert', ({ profile }) => {
    const db = requireDb();
    return upsertRecurringProfile(db, profile);
  });

  register(ipcMain, 'recurring:delete', ({ id }) => {
    const db = requireDb();
    deleteRecurringProfile(db, id);
    return { ok: true };
  });

  register(ipcMain, 'settings:get', () => {
    const db = requireDb();
    return getSettings(db);
  });

  register(ipcMain, 'settings:set', ({ settings }) => {
    const db = requireDb();
    setSettings(db, settings);
    return { ok: true };
  });

  register(ipcMain, 'numbers:reserve', ({ kind }) => {
    const db = requireDb();
    return reserveNumber(db, kind);
  });

  register(ipcMain, 'numbers:release', ({ reservationId }) => {
    const db = requireDb();
    return releaseNumber(db, reservationId);
  });

  register(ipcMain, 'numbers:finalize', ({ reservationId, documentId }) => {
    const db = requireDb();
    return finalizeNumber(db, reservationId, documentId);
  });

  register(ipcMain, 'documents:createFromClient', ({ kind, clientId }) => {
    const db = requireDb();
    const normalizedKind = kind === 'offer' ? 'offer' : 'invoice';
    const settings = requireSettings(db);

    const client = getClient(db, clientId);
    if (!client) throw new Error('Client not found');

    const defaultProject = ensureDefaultProjectForClient(db, clientId);

    const addresses = client.addresses ?? [];
    const emails = client.emails ?? [];

    const billingAddress =
      addresses.find((a) => a.isDefaultBilling) ??
      addresses.find((a) => a.kind === 'billing') ??
      addresses[0] ??
      null;

    const shippingAddress =
      addresses.find((a) => a.isDefaultShipping) ??
      addresses.find((a) => a.kind === 'shipping') ??
      billingAddress ??
      null;

    const billingEmail =
      emails.find((e) => e.isDefaultBilling) ??
      emails.find((e) => e.isDefaultGeneral) ??
      emails[0] ??
      null;

    const numberReservation = reserveNumber(db, normalizedKind);

    const today = new Date().toISOString().split('T')[0];
    const base: Invoice = {
      id: crypto.randomUUID(),
      clientId: client.id,
      clientNumber: client.customerNumber,
      projectId: defaultProject.id,
      number: numberReservation.number,
      numberReservationId: numberReservation.reservationId,
      client: client.company,
      clientEmail: billingEmail?.email ?? '',
      clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : '',
      billingAddressJson: billingAddress ?? null,
      shippingAddressJson: shippingAddress ?? null,
      taxMode: resolveInvoiceTaxMode(undefined, settings),
      date: today,
      dueDate: normalizedKind === 'offer' ? today : '',
      amount: 0,
      status: 'draft',
      items: [],
      payments: [],
      history: [],
    };

    return normalizeInvoiceTaxData(base, settings);
  });

  register(ipcMain, 'documents:convertOfferToInvoice', ({ offerId, invoiceDate, dueDate }) => {
    const db = requireDb();
    const newInvoiceId = crypto.randomUUID();
    return createInvoiceFromOffer(db, offerId, newInvoiceId, { invoiceDate, dueDate });
  });

  register(ipcMain, 'templates:list', ({ kind }) => {
    const db = requireDb();
    const normalized = kind === 'offer' ? 'offer' : kind === 'invoice' ? 'invoice' : undefined;
    return listTemplates(db, normalized as DocumentTemplateKind | undefined);
  });

  register(ipcMain, 'templates:active', ({ kind }) => {
    const db = requireDb();
    const normalized = kind === 'offer' ? 'offer' : 'invoice';
    return getActiveTemplate(db, normalized);
  });

  register(ipcMain, 'templates:upsert', ({ template }) => {
    const db = requireDb();
    return upsertTemplate(db, template);
  });

  register(ipcMain, 'templates:delete', ({ id }) => {
    const db = requireDb();
    deleteTemplate(db, id);
    return { ok: true };
  });

  register(ipcMain, 'templates:setActive', ({ kind, templateId }) => {
    const db = requireDb();
    setActiveTemplateId(db, kind, templateId);
    return { ok: true };
  });

  register(ipcMain, 'audit:verify', () => {
    const db = requireDb();
    return verifyAuditChain(db);
  });

  register(ipcMain, 'audit:exportCsv', () => {
    const db = requireDb();
    return exportAuditCsv(db);
  });

  register(ipcMain, 'pdf:export', async ({ kind, id }) => {
    const db = requireDb();
    const userDataPath = getUserDataPath();

    if (kind === 'offer') {
      const offer = getOffer(db, id);
      if (!offer) throw new Error('Offer not found');
      const res = await exportPdf({
        kind: 'offer',
        id,
        suggestedName: `${offer.number || 'offer'}-${offer.client || id}`,
        userDataPath,
      });
      return { path: res.path };
    }

    const invoice = getInvoice(db, id);
    if (!invoice) throw new Error('Invoice not found');
    const res = await exportPdf({
      kind: 'invoice',
      id,
      suggestedName: `${invoice.number || 'invoice'}-${invoice.client || id}`,
      userDataPath,
    });
    const settings = requireSettings(db);
    if (settings.eInvoice?.enabled) {
      const normalized = normalizeInvoiceForEinvoice(invoice, settings);
      const xml = buildZugferdXml(normalized);
      const finalBytes = await embedZugferdInPdf({
        pdfBytes: res.bytes,
        xml,
        invoiceNumber: invoice.number,
      });
      fs.writeFileSync(res.path, finalBytes);
    }
    return { path: res.path };
  });

  register(ipcMain, 'window:minimize', () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
    return { ok: true };
  });

  register(ipcMain, 'window:toggleMaximize', () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
    return { ok: true };
  });

  register(ipcMain, 'window:close', () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    return { ok: true };
  });

  register(ipcMain, 'window:isMaximized', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { isMaximized: false };
    }
    return { isMaximized: mainWindow.isMaximized() };
  });

  register(ipcMain, 'shell:openPath', async ({ path: targetPath }) => {
    const userDataPath = getUserDataPath();
    const resolved = path.resolve(targetPath);
    const allowedRoots = [
      path.resolve(path.join(userDataPath, 'exports')),
      path.resolve(path.join(userDataPath, 'backups')),
    ];

    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
      throw new Error('Refusing to open path outside app userData folders');
    }

    const result = await shell.openPath(resolved);
    if (result) throw new Error(result);
    return { ok: true };
  });

  register(ipcMain, 'shell:openExportsDir', async () => {
    const userDataPath = getUserDataPath();
    const exportsDir = path.resolve(path.join(userDataPath, 'exports'));
    ensureDir(exportsDir);

    const result = await shell.openPath(exportsDir);
    if (result) throw new Error(result);
    return { ok: true };
  });

  register(ipcMain, 'shell:openExternal', async ({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are allowed');
    }
    await shell.openExternal(parsed.toString(), { activate: true });
    return { ok: true };
  });

  register(ipcMain, 'dialog:pickCsv', async ({ title }) => {
    const res = await dialog.showOpenDialog({
      title: title ?? 'CSV auswählen',
      properties: ['openFile'],
      filters: [
        { name: 'CSV', extensions: ['csv', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return { path: null };
    return { path: res.filePaths[0] ?? null };
  });

  register(ipcMain, 'finance:importPreview', async (args) => {
    return previewCsv({
      filePath: args.path,
      encoding: args.encoding,
      delimiter: args.delimiter,
      profile: args.profile ?? 'auto',
      mapping: args.mapping,
      maxRows: args.maxRows,
      accountIdForDedupHash: args.accountIdForDedupHash,
    });
  });

  register(ipcMain, 'finance:importCommit', async (args) => {
    const db = requireDb();

    const committed = commitCsv({
      filePath: args.path,
      accountId: args.accountId,
      encoding: args.encoding,
      delimiter: args.delimiter,
      profile: args.profile ?? 'auto',
      mapping: args.mapping,
    });

    // FIRST PASS: Validate ALL rows and collect errors
    const errors: Array<{ rowIndex: number; message: string }> = [];
    const toInsert: Array<{
      id: string;
      accountId: string;
      date: string;
      amount: number;
      type: string;
      counterparty: string;
      purpose: string;
      status: string;
      dedupHash: string;
    }> = [];

    for (const r of committed.rows) {
      if (r.errors.length > 0) {
        errors.push({ rowIndex: r.rowIndex, message: r.errors.join('; ') });
        continue;
      }
      const date = r.parsed.date;
      const amount = r.parsed.amount;
      const type = r.parsed.type;
      if (!date || typeof amount !== 'number' || !type || !r.dedupHash) {
        errors.push({ rowIndex: r.rowIndex, message: 'Fehlende erforderliche Felder' });
        continue;
      }
      toInsert.push({
        id: crypto.randomUUID(),
        accountId: args.accountId,
        date,
        amount,
        type,
        counterparty: r.parsed.counterparty ?? '',
        purpose: r.parsed.purpose ?? '',
        status: r.parsed.status ?? 'booked',
        dedupHash: r.dedupHash,
      });
    }

    // Calculate error rate
    const totalRows = committed.rows.length;
    const errorRate = totalRows > 0 ? (errors.length / totalRows) * 100 : 0;

    // Fail fast if error rate exceeds 50%
    if (errorRate > 50) {
      throw new Error(
        `Import abgebrochen: ${errors.length} von ${totalRows} Zeilen fehlerhaft (${errorRate.toFixed(1)}%).\n` +
        `Bitte überprüfen Sie das CSV-Format und die Spaltenzuordnung.\n` +
        `Maximal 50% Fehlerrate erlaubt.`
      );
    }

    // SECOND PASS: Only if error rate is acceptable, commit to database
    const result = db.transaction(() => {
      const batchId = createImportBatch(db, {
        accountId: args.accountId,
        profile: committed.profile,
        fileName: committed.fileName,
        fileSha256: committed.fileSha256,
        mappingJson: {
          profile: args.profile ?? 'auto',
          mapping: args.mapping,
          encoding: args.encoding,
          delimiter: args.delimiter,
        },
        importedCount: 0,
        skippedCount: 0,
        errorCount: errors.length,
      });

      const { inserted, skipped } = insertTransactionsIgnoringDuplicates(
        db,
        toInsert.map((t) => ({ ...t, importBatchId: batchId, linkedInvoiceId: null })),
      );

      db.prepare(
        `
          UPDATE import_batches
          SET imported_count = @imported, skipped_count = @skipped, error_count = @errors
          WHERE id = @id
        `,
      ).run({ id: batchId, imported: inserted, skipped, errors: errors.length });

      return { batchId, inserted, skipped };
    })();

    return {
      batchId: result.batchId,
      imported: result.inserted,
      skipped: result.skipped,
      errors,
      fileSha256: committed.fileSha256,
    };
  });

  register(ipcMain, 'portal:health', async ({ baseUrl }) => {
    return portalClient.health(baseUrl);
  });

  register(ipcMain, 'portal:publishOffer', async ({ offerId, expiresAt }) => {
    const db = requireDb();

    const offer = getOffer(db, offerId);
    if (!offer) throw new Error('Offer not found');

    const settings = getSettings(db);
    const baseUrl = settings?.portal?.baseUrl?.trim();
    if (!baseUrl) throw new Error('Portal baseUrl not configured (Settings → Portal)');

    const res = await publishOfferToPortal(db, {
      offerId,
      expiresAt,
      portalGateway: {
        publishOffer: async ({ expiresAt: publishExpiresAt }) => {
          const apiKey = await secrets.get('portal.apiKey');
          const token = crypto.randomBytes(24).toString('base64url');
          const pdf = await exportPdf({
            kind: 'offer',
            id: offerId,
            suggestedName: `${offer.number || 'offer'}-${offer.client || offerId}`,
            userDataPath: getUserDataPath(),
          });

          return portalClient.publishOffer({
            baseUrl,
            apiKey,
            token,
            snapshot: offer,
            customerRef: deriveCustomerRef(offer),
            customerLabel: offer.client,
            expiresAt: publishExpiresAt ?? offer.dueDate,
            pdfBytes: pdf.bytes,
          });
        },
      },
    });

    return { ok: true, token: res.token, publicUrl: res.publicUrl };
  });

  register(ipcMain, 'portal:syncOfferStatus', async ({ offerId }) => {
    const db = requireDb();

    const settings = getSettings(db);
    const baseUrl = settings?.portal?.baseUrl?.trim();
    if (!baseUrl) throw new Error('Portal baseUrl not configured (Settings → Portal)');

    const result = await syncPublishedOfferDecisionFromPortal(db, {
      offerId,
      portalGateway: {
        getOfferStatus: (shareToken) => portalClient.getOfferStatus(baseUrl, shareToken),
      },
    });

    return { ok: true, decision: result.decision, updated: result.updated };
  });

  register(ipcMain, 'portal:publishInvoice', async ({ invoiceId, expiresAt }) => {
    const db = requireDb();

    const invoice = getInvoice(db, invoiceId);
    if (!invoice) throw new Error('Invoice not found');

    const settings = getSettings(db);
    const baseUrl = settings?.portal?.baseUrl?.trim();
    if (!baseUrl) throw new Error('Portal baseUrl not configured (Settings → Portal)');

    const apiKey = await secrets.get('portal.apiKey');
    const token = crypto.randomBytes(24).toString('base64url');

    const pdf = await exportPdf({
      kind: 'invoice',
      id: invoiceId,
      suggestedName: `${invoice.number || 'invoice'}-${invoice.client || invoiceId}`,
      userDataPath: getUserDataPath(),
    });

    return portalClient.publishInvoice({
      baseUrl,
      apiKey,
      token,
      snapshot: invoice,
      customerRef: deriveCustomerRef(invoice),
      customerLabel: invoice.client,
      expiresAt: expiresAt ?? invoice.dueDate,
      pdfBytes: pdf.bytes,
    });
  });

  register(ipcMain, 'portal:createCustomerAccessLink', async ({ customerRef, customerLabel, expiresInDays }) => {
    const db = requireDb();
    const settings = getSettings(db);
    const baseUrl = settings?.portal?.baseUrl?.trim();
    if (!baseUrl) throw new Error('Portal baseUrl not configured (Settings → Portal)');
    const apiKey = await secrets.get('portal.apiKey');
    return portalClient.createCustomerAccessLink({ baseUrl, apiKey, customerRef, customerLabel, expiresInDays });
  });

  register(ipcMain, 'portal:rotateCustomerAccessLink', async ({ customerRef, customerLabel, expiresInDays }) => {
    const db = requireDb();
    const settings = getSettings(db);
    const baseUrl = settings?.portal?.baseUrl?.trim();
    if (!baseUrl) throw new Error('Portal baseUrl not configured (Settings → Portal)');
    const apiKey = await secrets.get('portal.apiKey');
    return portalClient.rotateCustomerAccessLink({ baseUrl, apiKey, customerRef, customerLabel, expiresInDays });
  });

  register(ipcMain, 'secrets:get', async ({ key }) => {
    return secrets.get(key);
  });

  register(ipcMain, 'secrets:set', async ({ key, value }) => {
    await secrets.set(key, value);
  });

  register(ipcMain, 'secrets:delete', async ({ key }) => {
    return secrets.delete(key);
  });

  register(ipcMain, 'secrets:has', async ({ key }) => {
    const value = await secrets.get(key);
    return Boolean(value && value.length > 0);
  });

  register(ipcMain, 'db:backup', async () => {
    const db = requireDb();
    const userDataPath = getUserDataPath();

    const backupsDir = path.join(userDataPath, 'backups');
    ensureDir(backupsDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `${PRODUCT_PROFILE.backupPrefix}-${ts}.sqlite`);
    await backupSqlite(db, dest);
    return { path: dest };
  });

  register(ipcMain, 'db:restore', ({ path: restorePath }) => {
    const userDataPath = getUserDataPath();
    const backupsDir = path.resolve(path.join(userDataPath, 'backups'));
    const resolved = path.resolve(restorePath);
    const allowedExt = /\.(sqlite|db)$/i.test(resolved);
    if (!allowedExt) throw new Error('Restore expects a .sqlite or .db backup file');
    if (!(resolved === backupsDir || resolved.startsWith(backupsDir + path.sep))) {
      throw new Error('Refusing to restore from outside backups directory');
    }
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Restore path must be a regular file');
    }
    const header = Buffer.alloc(16);
    const fd = fs.openSync(resolved, 'r');
    try {
      fs.readSync(fd, header, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString('utf8') !== 'SQLite format 3\u0000') {
      throw new Error('Restore file is not a valid SQLite database');
    }

    // Close existing DB, overwrite it, reopen.
    try {
      closeDb();
    } catch (error) {
      logger.warn('IPC:Backup', 'Failed to close database before restore', { error: String(error) });
    }

    const destDbPath = getDbPath();
    fs.copyFileSync(resolved, destDbPath);
    initDb(userDataPath, { dbFileName: PRODUCT_PROFILE.dbFileName });
    const verification = verifyAuditChain(getDb());
    return { ok: verification.ok, verification };
  });

  register(ipcMain, 'tax:auditExportPackage', ({ from, to, includeDocuments, actorRole }) => {
    assertProRoleAllowed('tax:auditExportPackage', actorRole, ['accountant', 'admin', 'auditor']);
    const db = requireDb();
    return buildTaxAuditExportPackage(db, getUserDataPath(), {
      from,
      to,
      includeDocuments,
    });
  });

  register(ipcMain, 'email:send', async ({
    documentType,
    documentId,
    recipientEmail,
    recipientName,
    subject,
    bodyText,
  }) => {
    const db = requireDb();
    const userDataPath = getUserDataPath();

    // Get settings to determine email provider
    const settings = getSettings(db);
    if (!settings || !settings.email) {
      return {
        success: false,
        error: 'Email settings not configured',
      };
    }

    if (settings.email.provider === 'none') {
      return {
        success: false,
        error: 'No email provider configured. Please configure SMTP or Resend in Settings.',
      };
    }

    // Get the document
    const document = documentType === 'invoice' ? getInvoice(db, documentId) : getOffer(db, documentId);
    if (!document) {
      return {
        success: false,
        error: `${documentType === 'invoice' ? 'Invoice' : 'Offer'} not found`,
      };
    }

    // Generate PDF
    let pdfPath: string;
    try {
      const res = await exportPdf({
        kind: documentType,
        id: documentId,
        suggestedName: `${document.number || documentType}-${document.client || documentId}`,
        userDataPath,
      });
      pdfPath = res.path;
    } catch (e) {
      return {
        success: false,
        error: `Failed to generate PDF: ${String(e)}`,
      };
    }

    // Prepare email options
    const emailOptions: EmailOptions = {
      from: {
        name: settings.email.fromName || settings.company.name,
        email: settings.email.fromEmail || settings.company.email,
      },
      to: {
        name: recipientName,
        email: recipientEmail,
      },
      subject,
      text: bodyText,
      attachments: [
        {
          filename: `${document.number}.pdf`,
          path: pdfPath,
        },
      ],
    };

    // Get provider credentials
    let providerConfig: SmtpConfig | ResendConfig;
    if (settings.email.provider === 'smtp') {
      const smtpPassword = await secrets.get('smtp.password');
      if (!smtpPassword) {
        return {
          success: false,
          error: 'SMTP password not set. Please configure it in Settings.',
        };
      }

      providerConfig = {
        host: settings.email.smtpHost,
        port: settings.email.smtpPort,
        secure: settings.email.smtpSecure,
        auth: {
          user: settings.email.smtpUser,
          pass: smtpPassword,
        },
      } as SmtpConfig;
    } else {
      // Resend
      const resendApiKey = await secrets.get('resend.apiKey');
      if (!resendApiKey) {
        return {
          success: false,
          error: 'Resend API key not set. Please configure it in Settings.',
        };
      }

      providerConfig = {
        apiKey: resendApiKey,
      } as ResendConfig;
    }

    // Send email
    const result = await sendEmail(settings.email.provider, providerConfig, emailOptions);

    // Log to database
    const now = new Date().toISOString();
    logEmail(db, {
      id: crypto.randomUUID(),
      documentType,
      documentId,
      documentNumber: document.number,
      recipientEmail,
      recipientName,
      subject,
      bodyText,
      provider: settings.email.provider,
      status: result.success ? 'sent' : 'failed',
      errorMessage: result.error,
      sentAt: now,
      createdAt: now,
    });

    return result;
  });

  register(ipcMain, 'email:testConfig', async ({
    provider,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPassword,
    resendApiKey,
  }) => {
    let providerConfig: SmtpConfig | ResendConfig;

    if (provider === 'smtp') {
      const resolvedSmtpPassword = smtpPassword || (await secrets.get('smtp.password')) || undefined;
      if (!smtpHost || !smtpPort || !smtpUser || !resolvedSmtpPassword) {
        return {
          success: false,
          error: 'SMTP-Konfiguration unvollständig. Bitte füllen Sie alle erforderlichen Felder aus.',
        };
      }

      providerConfig = {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure ?? true,
        auth: {
          user: smtpUser,
          pass: resolvedSmtpPassword,
        },
      } as SmtpConfig;
    } else {
      const resolvedResendApiKey = resendApiKey || (await secrets.get('resend.apiKey')) || undefined;
      if (!resolvedResendApiKey) {
        return {
          success: false,
          error: 'Resend API-Key fehlt. Bitte geben Sie einen gültigen API-Key ein.',
        };
      }

      providerConfig = {
        apiKey: resolvedResendApiKey,
      } as ResendConfig;
    }

    return testEmailConfig(provider, providerConfig);
  });

  register(ipcMain, 'transactions:list', (filters) => {
    const db = requireDb();
    return listTransactions(db, filters);
  });

  register(ipcMain, 'transactions:findMatches', ({ transactionId }) => {
    const db = requireDb();
    const unmatchedTransactions = getUnmatchedTransactions(db);
    const transaction = unmatchedTransactions.find((t) => t.id === transactionId);

    if (!transaction) {
      throw new Error('Transaction not found or already matched');
    }

    const suggestions = findInvoiceMatches(db, transaction);

    return {
      transaction,
      suggestions,
    };
  });

  register(ipcMain, 'transactions:link', ({ transactionId, invoiceId }) => {
    const db = requireDb();
    return linkTransactionToInvoice(db, transactionId, invoiceId);
  });

  register(ipcMain, 'transactions:unlink', ({ transactionId }) => {
    const db = requireDb();
    return unlinkTransactionFromInvoice(db, transactionId);
  });

  register(ipcMain, 'dunning:manualRun', async () => {
    return await manualDunningRun();
  });

  register(ipcMain, 'dunning:getInvoiceStatus', ({ invoiceId }) => {
    const db = requireDb();
    return getInvoiceDunningStatus(db, invoiceId);
  });

  register(ipcMain, 'recurring:manualRun', async () => {
    return await manualRecurringRun();
  });

  register(ipcMain, 'finance:listImportBatches', ({ accountId, limit }) => {
    const db = requireDb();
    return listImportBatches(db, accountId, limit);
  });

  register(ipcMain, 'finance:getImportBatchDetails', ({ batchId }) => {
    const db = requireDb();
    return getImportBatchDetails(db, batchId);
  });

  register(ipcMain, 'finance:rollbackImportBatch', ({ batchId, reason }) => {
    const db = requireDb();
    return rollbackImportBatch(db, batchId, reason);
  });

  register(ipcMain, 'pro:importSkr', (args) => {
    const db = requireDb();
    const result = importSkrCharts(db, args);
    if (result.total > 0) {
      seedAccountKeywords(db, getProScope());
    }
    return result;
  });

  register(ipcMain, 'pro:listLedgerAccounts', (args) => {
    return getProAccountingFacade().catalog.listLedgerAccounts(args);
  });

  register(ipcMain, 'pro:listTaxCases', ({ activeOnly }) => {
    return getProAccountingFacade().catalog.listTaxCases({ activeOnly });
  });

  register(ipcMain, 'pro:listTaxCaseAccountMappings', ({ chart, taxCaseKey }) => {
    return getProAccountingFacade().catalog.listTaxCaseAccountMappings({ chart, taxCaseKey });
  });

  register(ipcMain, 'pro:upsertTaxCaseAccountMapping', (args) => {
    return getProAccountingFacade().catalog.upsertTaxCaseAccountMapping(args);
  });

  register(ipcMain, 'pro:getLedgerStats', () => {
    return getProAccountingFacade().catalog.getLedgerStats();
  });

  register(ipcMain, 'pro:listBankTransactions', () => {
    return getProAccountingFacade().accounting.listBankTransactions().then((rows) =>
      rows.map((tx) => ({
        id: tx.id,
        accountId: tx.accountId,
        date: tx.date,
        amount: tx.amount,
        type: tx.type,
        counterparty: tx.counterparty,
        purpose: tx.purpose,
        linkedInvoiceId: tx.linkedInvoiceId,
        status: tx.status,
        suggestedAccountNumber: tx.suggestedAccountNumber,
        suggestionReason: tx.suggestionReason,
        suggestionLayer: tx.suggestionLayer,
        suggestionConfidence: tx.suggestionConfidence,
      })),
    );
  });

  register(ipcMain, 'pro:listAccountSuggestionRules', ({ chart, activeOnly }) => {
    return getProAccountingFacade().catalog.listAccountSuggestionRules({ chart, activeOnly });
  });

  register(ipcMain, 'pro:upsertAccountSuggestionRule', (args) => {
    return getProAccountingFacade().catalog.upsertAccountSuggestionRule(args);
  });

  register(ipcMain, 'pro:deleteAccountSuggestionRule', ({ id }) => {
    return getProAccountingFacade().catalog.deleteAccountSuggestionRule(id).then(() => ({ ok: true }));
  });

  register(ipcMain, 'pro:getDraftByTransactionId', ({ transactionId }) => {
    return getProAccountingFacade().accounting.getDraftByTransactionId(transactionId);
  });

  register(ipcMain, 'pro:saveDraft', ({ draft }) => {
    return getProAccountingFacade().accounting.saveDraft(draft);
  });

  register(ipcMain, 'pro:dispatchDraftAction', ({ transactionId, action, rejectReason }) => {
    return getProAccountingFacade().accounting.dispatchDraftAction({ transactionId, action, rejectReason });
  });

  register(ipcMain, 'pro:postDraft', ({ draftId, postingDate, actorRole }) => {
    assertProRoleAllowed('pro:postDraft', actorRole, ['reviewer', 'accountant', 'admin']);
    return getProAccountingFacade().accounting.postDraft(draftId, { postingDate });
  });

  register(ipcMain, 'pro:reverseJournalEntry', ({ entryId, reason, actorRole }) => {
    assertProRoleAllowed('pro:reverseJournalEntry', actorRole, ['accountant', 'admin']);
    return getProAccountingFacade().accounting.reverseJournalEntry(entryId, reason);
  });

  register(ipcMain, 'pro:listJournalEntries', ({ from, to, limit, offset }) => {
    return getProAccountingFacade().accounting.listJournalEntries({ from, to, limit, offset });
  });

  register(ipcMain, 'pro:getLedgerBalances', ({ asOfDate }) => {
    return getProAccountingFacade().accounting.getLedgerBalances({ asOfDate });
  });

  register(ipcMain, 'pro:getSusaReport', ({ asOfDate }) => {
    return getProAccountingFacade().accounting.getSusaReport({ asOfDate });
  });

  register(ipcMain, 'pro:getGuvReport', ({ from, to }) => {
    return getProAccountingFacade().accounting.getGuvReport({ from, to });
  });

  register(ipcMain, 'pro:getBilanzReport', ({ asOfDate }) => {
    return getProAccountingFacade().accounting.getBilanzReport({ asOfDate });
  });

  register(ipcMain, 'pro:exportDatevBuchungsstapel', ({ from, to, actorRole }) => {
    assertProRoleAllowed('pro:exportDatevBuchungsstapel', actorRole, ['accountant', 'admin']);
    const accounting = getProAccountingFacade().accounting;
    return accounting.buildDatevRows({ from, to }).then((rows) => {
      const userDataPath = getUserDataPath();
      const exportDir = path.join(userDataPath, 'exports', 'datev');
      fs.mkdirSync(exportDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportPath = path.join(exportDir, `datev-buchungsstapel-${timestamp}.csv`);
      const csvBuffer = buildDatevBuchungsstapelCsv(rows);
      fs.writeFileSync(exportPath, csvBuffer);
      return accounting.insertDatevExport({
        filePath: exportPath,
        recordCount: rows.length,
        fromDate: from,
        toDate: to,
      });
    });
  });

  register(ipcMain, 'pro:listDatevExports', ({ limit }) => {
    return getProAccountingFacade().accounting.listDatevExports().then((rows) => (limit ? rows.slice(0, limit) : rows));
  });

  register(ipcMain, 'pro:getAccountingHealth', () => {
    return getProAccountingFacade().accounting.getAccountingHealth();
  });

  register(ipcMain, 'pro:validateTaxCompliance', ({ draftId, transactionId }) => {
    return getProAccountingFacade().accounting.validateTaxCompliance({ draftId, transactionId });
  });

  register(ipcMain, 'pro:getVatSummary', ({ from, to }) => {
    return getProAccountingFacade().accounting.getVatSummary({ from, to });
  });

  register(ipcMain, 'pro:listWorkflowEntries', () => {
    return getProAccountingFacade().workflow.list();
  });

  register(ipcMain, 'pro:upsertWorkflowEntry', ({ transactionId, transactionJson, draftJson }) => {
    return getProAccountingFacade().workflow.upsert({ transactionId, transactionJson, draftJson });
  });

  register(ipcMain, 'updater:getStatus', () => {
    return getCurrentUpdateStatus();
  });

  register(ipcMain, 'updater:downloadUpdate', async () => {
    await downloadUpdate();
    return { ok: true };
  });

  register(ipcMain, 'updater:quitAndInstall', () => {
    quitAndInstall();
    return { ok: true };
  });

  register(ipcMain, 'eur:getReport', ({ taxYear, from, to }) => {
    const db = requireDb();
    const settings = requireSettings(db);
    return getEurReport(db, { taxYear, from, to, settings });
  });

  register(ipcMain, 'eur:listItems', ({
    taxYear,
    from,
    to,
    onlyUnclassified,
    sourceType,
    flowType,
    status,
    search,
    accountId,
    limit,
    offset,
  }) => {
    const db = requireDb();
    const settings = requireSettings(db);
    return listEurItems(db, {
      taxYear,
      from,
      to,
      settings,
      onlyUnclassified,
      sourceType,
      flowType,
      status,
      search,
      accountId,
      limit,
      offset,
    });
  });

  register(ipcMain, 'eur:upsertClassification', ({
    sourceType,
    sourceId,
    taxYear,
    eurLineId,
    excluded,
    vatMode,
    note,
  }) => {
    const db = requireDb();
    return upsertEurItemClassification(db, {
      sourceType,
      sourceId,
      taxYear,
      eurLineId,
      excluded,
      vatMode,
      note,
    });
  });

  register(ipcMain, 'eur:exportCsv', ({ taxYear, from, to }) => {
    const db = requireDb();
    const settings = requireSettings(db);
    const report = getEurReport(db, { taxYear, from, to, settings });
    return buildEurCsv(report);
  });

  register(ipcMain, 'eur:exportPdf', async ({ taxYear, from, to }) => {
    const userDataPath = getUserDataPath();
    return exportEurPdf({ taxYear, from, to, userDataPath });
  });

  register(ipcMain, 'eur:listRules', ({ taxYear }) => {
    const db = requireDb();
    return listAllEurRules(db, taxYear);
  });

  register(ipcMain, 'eur:upsertRule', (args) => {
    const db = requireDb();
    return upsertEurRule(db, args);
  });

  register(ipcMain, 'eur:deleteRule', ({ id }) => {
    const db = requireDb();
    deleteEurRule(db, id);
    return { ok: true };
  });
};
