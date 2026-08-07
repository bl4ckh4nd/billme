import { randomUUID } from 'node:crypto';
import type {
  AccountSuggestionRule,
  AccountSuggestionRuleField,
  AccountSuggestionRuleFlowType,
  AccountSuggestionRuleOperator,
  DatevExportResult,
  LedgerAccount,
  LedgerAccountStats,
  ListLedgerAccountsArgs,
  ProBankTransaction,
  ProWorkflowEntry,
  TaxCaseAccountMapping,
  TaxCaseDefinition,
  UpsertAccountSuggestionRuleInput,
  ValidationIssue,
} from '@billme/accounting-shared';
import type { ProAccountingCatalogRepository, ProWorkflowRepository, TenantScope } from '@billme/server-core';
import { and, asc, count, desc, eq, ilike, or } from 'drizzle-orm';
import type { PostgresQueryable } from './connection.js';
import { createDrizzle, schema } from './drizzle.js';

const toNumber = (value: string | number): number => (typeof value === 'number' ? value : Number(value));
const getTenantId = (scope: TenantScope): string => scope.tenantId;
const nowIso = (): string => new Date().toISOString();
const drizzleDb = (db: PostgresQueryable) => createDrizzle(db as never);
const upsert = async (db: PostgresQueryable, table: any, values: any, target: any, set: any): Promise<void> => {
  await drizzleDb(db).insert(table).values(values).onConflictDoUpdate({ target, set });
};

export interface ServerArticleRecord {
  id: string;
  tenantId: string;
  sku?: string;
  title: string;
  description: string;
  price: number;
  unit: string;
  category: string;
  taxRate: number;
}

export interface ServerBankAccountRecord {
  id: string;
  tenantId: string;
  name: string;
  iban: string;
  balance: number;
  defaultSkrAccountNumber: string;
  type: string;
  color: string;
}

export interface ServerTemplateRecord {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  elementsJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerActiveTemplatesRecord {
  tenantId: string;
  id: number;
  invoiceTemplateId?: string;
  offerTemplateId?: string;
}

export interface ServerProWorkflowRecord extends ProWorkflowEntry {
  tenantId: string;
}

export interface ServerBankTransactionRecord extends ProBankTransaction {
  sourceTransactionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerBookingDraftRecord {
  id: string;
  tenantId: string;
  transactionId: string;
  workflowStatus: string;
  draftJson: string;
  updatedAt: string;
}

export interface ServerBookingDraftLineRecord {
  id: string;
  tenantId: string;
  draftId: string;
  lineNo: number;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCode?: string;
  taxCaseKey?: string;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
  memo?: string;
}

export interface ServerDraftValidationIssueRecord {
  id: string;
  tenantId: string;
  draftId: string;
  code: string;
  severity: ValidationIssue['severity'];
  message: string;
  fieldPath?: string;
  blocking: boolean;
  source: ValidationIssue['source'];
  issueJson: string;
  createdAt: string;
}

export interface ServerAccountingPeriodRecord {
  id: string;
  tenantId: string;
  period: string;
  fiscalYear: number;
  status: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerJournalEntryRecord {
  id: string;
  tenantId: string;
  entryNumber: number;
  postingDate: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  status: string;
  sourceDraftId?: string;
  reversedEntryId?: string;
  createdAt: string;
}

export interface ServerJournalLineRecord {
  id: string;
  tenantId: string;
  entryId: string;
  lineNo: number;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCode?: string;
  taxCaseKey?: string;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
  memo?: string;
}

export interface ServerAccountMappingHgbRecord {
  id: string;
  tenantId: string;
  chart: string;
  accountNumber: string;
  statementType: string;
  positionKey: string;
  positionLabel: string;
  balanceSide?: string;
  updatedAt: string;
}

export interface ServerReportSnapshotRecord {
  id: string;
  tenantId: string;
  reportType: string;
  argsJson: string;
  payloadJson: string;
  createdAt: string;
}

export interface ServerDatevExportRecord extends DatevExportResult {
  tenantId: string;
  metaJson: string;
}

export interface ServerVatEvidenceRecord {
  id: string;
  tenantId: string;
  draftId?: string;
  entryId?: string;
  lineId?: string;
  taxCaseKey: string;
  evidenceType?: string;
  evidenceReference?: string;
  countryCode?: string;
  counterpartyVatId?: string;
  capturedAt: string;
}

export interface ServerJournalPostingPairRecord {
  id: string;
  tenantId: string;
  entryId: string;
  debitLineId: string;
  creditLineId: string;
  amount: number;
  taxCaseKey?: string;
  datevBuKey?: string;
  createdAt: string;
}

export interface ServerImportedTransactionRecord {
  id: string;
  tenantId: string;
  accountId: string;
  date: string;
  amount: number;
  type: string;
  counterparty: string;
  purpose: string;
  linkedInvoiceId?: string;
  status: string;
  dedupHash?: string;
  importBatchId?: string;
  deletedAt?: string;
}

export interface ServerImportBatchRecord {
  id: string;
  tenantId: string;
  accountId: string;
  profile: string;
  fileName: string;
  fileSha256: string;
  mappingJson: string;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  createdAt: string;
  rolledBackAt?: string;
  rollbackReason?: string;
}

export interface ServerEurLineRecord {
  id: string;
  taxYear: number;
  kennziffer?: string;
  label: string;
  kind: string;
  exportable: boolean;
  sortOrder: number;
  computedFromJson?: string;
  sourceVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerEurClassificationRecord {
  id: string;
  tenantId: string;
  sourceType: string;
  sourceId: string;
  taxYear: number;
  eurLineId?: string;
  excluded: boolean;
  vatMode: string;
  note?: string;
  updatedAt: string;
}

export interface ServerEurRuleRecord {
  id: string;
  tenantId: string;
  taxYear: number;
  priority: number;
  field: string;
  operator: string;
  value: string;
  targetEurLineId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerAccountKeywordRecord {
  id: string;
  tenantId: string;
  chart: string;
  accountNumber: string;
  keyword: string;
  source: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerTaxCaseRecord extends TaxCaseDefinition {
  updatedAt: string;
}

export const listServerArticles = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<ServerArticleRecord[]> => {
  const rows = await drizzleDb(db).select().from(schema.articles).where(eq(schema.articles.tenantId, tenantId))
    .orderBy(asc(schema.articles.title), asc(schema.articles.id));
  return rows.map((row) => ({
    id: row.id!,
    tenantId: row.tenantId!,
    sku: row.sku ?? undefined,
    title: row.title!,
    description: row.description!,
    price: toNumber(row.price!),
    unit: row.unit!,
    category: row.category!,
    taxRate: toNumber(row.taxRate!),
  }));
};

export const saveServerArticle = async (
  db: PostgresQueryable,
  record: ServerArticleRecord,
): Promise<ServerArticleRecord> => {
  await upsert(db, schema.articles, { id: record.id, tenantId: record.tenantId, sku: record.sku ?? null,
    title: record.title, description: record.description, price: record.price, unit: record.unit,
    category: record.category, taxRate: record.taxRate }, schema.articles.id, {
      tenantId: record.tenantId, sku: record.sku ?? null, title: record.title, description: record.description,
      price: record.price, unit: record.unit, category: record.category, taxRate: record.taxRate,
    });
  return record;
};

export const listServerBankAccounts = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<ServerBankAccountRecord[]> => {
  const rows = await drizzleDb(db).select().from(schema.accounts).where(eq(schema.accounts.tenantId, tenantId))
    .orderBy(asc(schema.accounts.name), asc(schema.accounts.id));
  return rows.map((row) => ({
    id: row.id!,
    tenantId: row.tenantId!,
    name: row.name!,
    iban: row.iban!,
    balance: toNumber(row.balance!),
    defaultSkrAccountNumber: row.defaultSkrAccountNumber!,
    type: row.type!,
    color: row.color!,
  }));
};

export const saveServerBankAccount = async (
  db: PostgresQueryable,
  record: ServerBankAccountRecord,
): Promise<ServerBankAccountRecord> => {
  await upsert(db, schema.accounts, { id: record.id, tenantId: record.tenantId, name: record.name, iban: record.iban,
    balance: record.balance, defaultSkrAccountNumber: record.defaultSkrAccountNumber, type: record.type, color: record.color },
    schema.accounts.id, { tenantId: record.tenantId, name: record.name, iban: record.iban, balance: record.balance,
      defaultSkrAccountNumber: record.defaultSkrAccountNumber, type: record.type, color: record.color });
  return record;
};

export const listServerTemplates = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<ServerTemplateRecord[]> => {
  const rows = await drizzleDb(db).select().from(schema.templates).where(eq(schema.templates.tenantId, tenantId))
    .orderBy(asc(schema.templates.kind), asc(schema.templates.name), asc(schema.templates.id));
  return rows.map((row) => ({
    id: row.id!,
    tenantId: row.tenantId!,
    kind: row.kind!,
    name: row.name!,
    elementsJson: row.elementsJson!,
    createdAt: row.createdAt!,
    updatedAt: row.updatedAt!,
  }));
};

export const saveServerTemplate = async (
  db: PostgresQueryable,
  record: ServerTemplateRecord,
): Promise<ServerTemplateRecord> => {
  await upsert(db, schema.templates, { id: record.id, tenantId: record.tenantId, kind: record.kind, name: record.name,
    elementsJson: record.elementsJson, createdAt: record.createdAt, updatedAt: record.updatedAt }, schema.templates.id,
    { tenantId: record.tenantId, kind: record.kind, name: record.name, elementsJson: record.elementsJson, updatedAt: record.updatedAt });
  return record;
};

export const getServerActiveTemplates = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<ServerActiveTemplatesRecord | null> => {
  const row = (await drizzleDb(db).select().from(schema.activeTemplates)
    .where(eq(schema.activeTemplates.tenantId, tenantId)).limit(1))[0];
  if (!row) return null;
  return {
    tenantId: row.tenantId!,
    id: row.id!,
    invoiceTemplateId: row.invoiceTemplateId ?? undefined,
    offerTemplateId: row.offerTemplateId ?? undefined,
  };
};

export const saveServerActiveTemplates = async (
  db: PostgresQueryable,
  record: ServerActiveTemplatesRecord,
): Promise<ServerActiveTemplatesRecord> => {
  await upsert(db, schema.activeTemplates, { tenantId: record.tenantId, id: record.id,
    invoiceTemplateId: record.invoiceTemplateId ?? null, offerTemplateId: record.offerTemplateId ?? null }, schema.activeTemplates.tenantId,
    { id: record.id, invoiceTemplateId: record.invoiceTemplateId ?? null, offerTemplateId: record.offerTemplateId ?? null });
  return record;
};

export const saveServerLedgerAccount = async (db: PostgresQueryable, account: LedgerAccount): Promise<LedgerAccount> => {
  await upsert(db, schema.ledgerAccounts, { id: account.id, chart: account.chart, accountNumber: account.accountNumber, name: account.name, source: account.source, createdAt: account.createdAt, updatedAt: account.updatedAt },
    [schema.ledgerAccounts.chart, schema.ledgerAccounts.accountNumber], { name: account.name, source: account.source, updatedAt: account.updatedAt });
  return account;
};
export const saveServerTaxCase = async (db: PostgresQueryable, record: ServerTaxCaseRecord): Promise<ServerTaxCaseRecord> => {
  await upsert(db, schema.taxCases, { key: record.key, label: record.label, mechanism: record.mechanism, defaultRate: record.defaultRate, requiresCounterpartyVatId: record.requiresCounterpartyVatId, requiresCountry: record.requiresCountry, requiresEvidence: record.requiresEvidence, active: record.active, updatedAt: record.updatedAt }, schema.taxCases.key,
    { label: record.label, mechanism: record.mechanism, defaultRate: record.defaultRate, requiresCounterpartyVatId: record.requiresCounterpartyVatId, requiresCountry: record.requiresCountry, requiresEvidence: record.requiresEvidence, active: record.active, updatedAt: record.updatedAt });
  return record;
};
export const saveServerTaxCaseAccountMapping = async (db: PostgresQueryable, mapping: TaxCaseAccountMapping): Promise<TaxCaseAccountMapping> => {
  await upsert(db, schema.taxCaseAccountMappings, { id: mapping.id, chart: mapping.chart, taxCaseKey: mapping.taxCaseKey, role: mapping.role, accountNumber: mapping.accountNumber, datevBuKey: mapping.datevBuKey ?? null, validFrom: mapping.validFrom ?? null, validTo: mapping.validTo ?? null, updatedAt: mapping.updatedAt },
    [schema.taxCaseAccountMappings.chart, schema.taxCaseAccountMappings.taxCaseKey, schema.taxCaseAccountMappings.role], { accountNumber: mapping.accountNumber, datevBuKey: mapping.datevBuKey ?? null, validFrom: mapping.validFrom ?? null, validTo: mapping.validTo ?? null, updatedAt: mapping.updatedAt });
  return mapping;
};
export const saveServerAccountKeyword = async (db: PostgresQueryable, record: ServerAccountKeywordRecord): Promise<ServerAccountKeywordRecord> => {
  await upsert(db, schema.accountKeywords, { id: record.id, tenantId: record.tenantId, chart: record.chart, accountNumber: record.accountNumber, keyword: record.keyword, source: record.source, active: record.active, createdAt: record.createdAt, updatedAt: record.updatedAt },
    [schema.accountKeywords.tenantId, schema.accountKeywords.chart, schema.accountKeywords.accountNumber, schema.accountKeywords.keyword], { source: record.source, active: record.active, updatedAt: record.updatedAt });
  return record;
};
export const saveServerAccountSuggestionRule = async (db: PostgresQueryable, rule: AccountSuggestionRule): Promise<AccountSuggestionRule> => {
  await upsert(db, schema.accountSuggestionRules, { id: rule.id, tenantId: rule.tenantId, chart: rule.chart, priority: rule.priority, field: rule.field, operator: rule.operator, value: rule.value, targetAccountNumber: rule.targetAccountNumber, flowType: rule.flowType, active: rule.active, createdAt: rule.createdAt, updatedAt: rule.updatedAt }, schema.accountSuggestionRules.id,
    { tenantId: rule.tenantId, chart: rule.chart, priority: rule.priority, field: rule.field, operator: rule.operator, value: rule.value, targetAccountNumber: rule.targetAccountNumber, flowType: rule.flowType, active: rule.active, updatedAt: rule.updatedAt });
  return rule;
};
export const saveServerProWorkflowEntry = async (db: PostgresQueryable, record: ServerProWorkflowRecord): Promise<ServerProWorkflowRecord> => {
  await upsert(db, schema.proWorkflowEntries, { tenantId: record.tenantId, transactionId: record.transactionId, transactionJson: record.transactionJson, draftJson: record.draftJson, updatedAt: record.updatedAt },
    [schema.proWorkflowEntries.tenantId, schema.proWorkflowEntries.transactionId], { transactionJson: record.transactionJson, draftJson: record.draftJson, updatedAt: record.updatedAt });
  return record;
};
export const saveServerBankTransaction = async (db: PostgresQueryable, record: ServerBankTransactionRecord): Promise<ServerBankTransactionRecord> => {
  await upsert(db, schema.bankTransactions, { id: record.id, tenantId: record.tenantId, accountId: record.accountId, date: record.date, amount: record.amount, type: record.type, counterparty: record.counterparty, purpose: record.purpose, linkedInvoiceId: record.linkedInvoiceId ?? null, status: record.status, sourceTransactionId: record.sourceTransactionId ?? null, createdAt: record.createdAt, updatedAt: record.updatedAt }, schema.bankTransactions.id,
    { tenantId: record.tenantId, accountId: record.accountId, date: record.date, amount: record.amount, type: record.type, counterparty: record.counterparty, purpose: record.purpose, linkedInvoiceId: record.linkedInvoiceId ?? null, status: record.status, sourceTransactionId: record.sourceTransactionId ?? null, updatedAt: record.updatedAt });
  return record;
};
export const saveServerBookingDraft = async (db: PostgresQueryable, record: ServerBookingDraftRecord): Promise<ServerBookingDraftRecord> => {
  await upsert(db, schema.bookingDrafts, { id: record.id, tenantId: record.tenantId, transactionId: record.transactionId, workflowStatus: record.workflowStatus, draftJson: record.draftJson, updatedAt: record.updatedAt }, schema.bookingDrafts.id,
    { tenantId: record.tenantId, transactionId: record.transactionId, workflowStatus: record.workflowStatus, draftJson: record.draftJson, updatedAt: record.updatedAt });
  return record;
};
export const saveServerBookingDraftLine = async (db: PostgresQueryable, record: ServerBookingDraftLineRecord): Promise<ServerBookingDraftLineRecord> => {
  await upsert(db, schema.bookingDraftLines, { id: record.id, tenantId: record.tenantId, draftId: record.draftId, lineNo: record.lineNo, accountNumber: record.accountNumber, debitAmount: record.debitAmount, creditAmount: record.creditAmount, taxCode: record.taxCode ?? null, taxCaseKey: record.taxCaseKey ?? null, taxRate: record.taxRate ?? null, netAmount: record.netAmount ?? null, taxAmount: record.taxAmount ?? null, grossAmount: record.grossAmount ?? null, countryCode: record.countryCode ?? null, counterpartyVatId: record.counterpartyVatId ?? null, evidenceType: record.evidenceType ?? null, evidenceReference: record.evidenceReference ?? null, costCenter: record.costCenter ?? null, memo: record.memo ?? null }, schema.bookingDraftLines.id,
    { tenantId: record.tenantId, draftId: record.draftId, lineNo: record.lineNo, accountNumber: record.accountNumber, debitAmount: record.debitAmount, creditAmount: record.creditAmount, taxCode: record.taxCode ?? null, taxCaseKey: record.taxCaseKey ?? null, taxRate: record.taxRate ?? null, netAmount: record.netAmount ?? null, grossAmount: record.grossAmount ?? null, taxAmount: record.taxAmount ?? null, countryCode: record.countryCode ?? null, counterpartyVatId: record.counterpartyVatId ?? null, evidenceType: record.evidenceType ?? null, evidenceReference: record.evidenceReference ?? null, costCenter: record.costCenter ?? null, memo: record.memo ?? null });
  return record;
};
export const saveServerDraftValidationIssue = async (db: PostgresQueryable, record: ServerDraftValidationIssueRecord): Promise<ServerDraftValidationIssueRecord> => {
  await upsert(db, schema.draftValidationIssues, { id: record.id, tenantId: record.tenantId, draftId: record.draftId, code: record.code, severity: record.severity, message: record.message, fieldPath: record.fieldPath ?? null, blocking: record.blocking, source: record.source, issueJson: record.issueJson, createdAt: record.createdAt }, schema.draftValidationIssues.id,
    { tenantId: record.tenantId, draftId: record.draftId, code: record.code, severity: record.severity, message: record.message, fieldPath: record.fieldPath ?? null, blocking: record.blocking, source: record.source, issueJson: record.issueJson, createdAt: record.createdAt });
  return record;
};
export const saveServerAccountingPeriod = async (db: PostgresQueryable, record: ServerAccountingPeriodRecord): Promise<ServerAccountingPeriodRecord> => {
  await upsert(db, schema.accountingPeriods, { id: record.id, tenantId: record.tenantId, period: record.period, fiscalYear: record.fiscalYear, status: record.status, startsAt: record.startsAt, endsAt: record.endsAt, createdAt: record.createdAt, updatedAt: record.updatedAt }, schema.accountingPeriods.id,
    { tenantId: record.tenantId, period: record.period, fiscalYear: record.fiscalYear, status: record.status, startsAt: record.startsAt, endsAt: record.endsAt, updatedAt: record.updatedAt });
  return record;
};
export const saveServerJournalEntry = async (db: PostgresQueryable, record: ServerJournalEntryRecord): Promise<ServerJournalEntryRecord> => {
  await upsert(db, schema.journalEntries, { id: record.id, tenantId: record.tenantId, entryNumber: record.entryNumber, postingDate: record.postingDate, documentDate: record.documentDate ?? null, bookingText: record.bookingText, reference: record.reference ?? null, period: record.period, fiscalYear: record.fiscalYear, status: record.status, sourceDraftId: record.sourceDraftId ?? null, reversedEntryId: record.reversedEntryId ?? null, createdAt: record.createdAt }, schema.journalEntries.id,
    { tenantId: record.tenantId, entryNumber: record.entryNumber, postingDate: record.postingDate, documentDate: record.documentDate ?? null, bookingText: record.bookingText, reference: record.reference ?? null, period: record.period, fiscalYear: record.fiscalYear, status: record.status, sourceDraftId: record.sourceDraftId ?? null, reversedEntryId: record.reversedEntryId ?? null, createdAt: record.createdAt });
  return record;
};
export const saveServerJournalLine = async (db: PostgresQueryable, record: ServerJournalLineRecord): Promise<ServerJournalLineRecord> => {
  const values = { id: record.id, tenantId: record.tenantId, entryId: record.entryId, lineNo: record.lineNo, accountNumber: record.accountNumber, debitAmount: record.debitAmount, creditAmount: record.creditAmount, taxCode: record.taxCode ?? null, taxCaseKey: record.taxCaseKey ?? null, taxRate: record.taxRate ?? null, netAmount: record.netAmount ?? null, taxAmount: record.taxAmount ?? null, grossAmount: record.grossAmount ?? null, countryCode: record.countryCode ?? null, counterpartyVatId: record.counterpartyVatId ?? null, evidenceType: record.evidenceType ?? null, evidenceReference: record.evidenceReference ?? null, costCenter: record.costCenter ?? null, memo: record.memo ?? null };
  await upsert(db, schema.journalLines, values, schema.journalLines.id, values);
  return record;
};
export const saveServerAccountMappingHgb = async (db: PostgresQueryable, record: ServerAccountMappingHgbRecord): Promise<ServerAccountMappingHgbRecord> => {
  await upsert(db, schema.accountMappingsHgb, { id: record.id, tenantId: record.tenantId, chart: record.chart, accountNumber: record.accountNumber, statementType: record.statementType, positionKey: record.positionKey, positionLabel: record.positionLabel, balanceSide: record.balanceSide ?? null, updatedAt: record.updatedAt },
    [schema.accountMappingsHgb.tenantId, schema.accountMappingsHgb.chart, schema.accountMappingsHgb.accountNumber, schema.accountMappingsHgb.statementType], { positionKey: record.positionKey, positionLabel: record.positionLabel, balanceSide: record.balanceSide ?? null, updatedAt: record.updatedAt });
  return record;
};
export const saveServerReportSnapshot = async (db: PostgresQueryable, record: ServerReportSnapshotRecord): Promise<ServerReportSnapshotRecord> => {
  await upsert(db, schema.reportSnapshots, { id: record.id, tenantId: record.tenantId, reportType: record.reportType, argsJson: record.argsJson, payloadJson: record.payloadJson, createdAt: record.createdAt }, schema.reportSnapshots.id,
    { tenantId: record.tenantId, reportType: record.reportType, argsJson: record.argsJson, payloadJson: record.payloadJson, createdAt: record.createdAt });
  return record;
};
export const saveServerDatevExport = async (db: PostgresQueryable, record: ServerDatevExportRecord): Promise<ServerDatevExportRecord> => {
  await upsert(db, schema.datevExports, { id: record.id, tenantId: record.tenantId, filePath: record.filePath, recordCount: record.recordCount, fromDate: record.fromDate ?? null, toDate: record.toDate ?? null, createdAt: record.createdAt, metaJson: record.metaJson }, schema.datevExports.id,
    { tenantId: record.tenantId, filePath: record.filePath, recordCount: record.recordCount, fromDate: record.fromDate ?? null, toDate: record.toDate ?? null, createdAt: record.createdAt, metaJson: record.metaJson });
  return record;
};
export const saveServerVatEvidence = async (db: PostgresQueryable, record: ServerVatEvidenceRecord): Promise<ServerVatEvidenceRecord> => {
  await upsert(db, schema.vatEvidence, { id: record.id, tenantId: record.tenantId, draftId: record.draftId ?? null, entryId: record.entryId ?? null, lineId: record.lineId ?? null, taxCaseKey: record.taxCaseKey, evidenceType: record.evidenceType ?? null, evidenceReference: record.evidenceReference ?? null, countryCode: record.countryCode ?? null, counterpartyVatId: record.counterpartyVatId ?? null, capturedAt: record.capturedAt }, schema.vatEvidence.id,
    { tenantId: record.tenantId, draftId: record.draftId ?? null, entryId: record.entryId ?? null, lineId: record.lineId ?? null, taxCaseKey: record.taxCaseKey, evidenceType: record.evidenceType ?? null, evidenceReference: record.evidenceReference ?? null, countryCode: record.countryCode ?? null, counterpartyVatId: record.counterpartyVatId ?? null, capturedAt: record.capturedAt });
  return record;
};
export const saveServerJournalPostingPair = async (db: PostgresQueryable, record: ServerJournalPostingPairRecord): Promise<ServerJournalPostingPairRecord> => {
  await upsert(db, schema.journalPostingPairs, { id: record.id, tenantId: record.tenantId, entryId: record.entryId, debitLineId: record.debitLineId, creditLineId: record.creditLineId, amount: record.amount, taxCaseKey: record.taxCaseKey ?? null, datevBuKey: record.datevBuKey ?? null, createdAt: record.createdAt }, schema.journalPostingPairs.id,
    { tenantId: record.tenantId, entryId: record.entryId, debitLineId: record.debitLineId, creditLineId: record.creditLineId, amount: record.amount, taxCaseKey: record.taxCaseKey ?? null, datevBuKey: record.datevBuKey ?? null, createdAt: record.createdAt });
  return record;
};
export const saveServerImportedTransaction = async (db: PostgresQueryable, record: ServerImportedTransactionRecord): Promise<ServerImportedTransactionRecord> => {
  const values = { id: record.id, tenantId: record.tenantId, accountId: record.accountId, date: record.date, amount: record.amount, type: record.type, counterparty: record.counterparty, purpose: record.purpose, linkedInvoiceId: record.linkedInvoiceId ?? null, status: record.status, dedupHash: record.dedupHash ?? null, importBatchId: record.importBatchId ?? null, deletedAt: record.deletedAt ?? null };
  await upsert(db, schema.transactions, values, schema.transactions.id, values);
  return record;
};
export const saveServerImportBatch = async (db: PostgresQueryable, record: ServerImportBatchRecord): Promise<ServerImportBatchRecord> => {
  const values = { id: record.id, tenantId: record.tenantId, accountId: record.accountId, profile: record.profile, fileName: record.fileName, fileSha256: record.fileSha256, mappingJson: record.mappingJson, importedCount: record.importedCount, skippedCount: record.skippedCount, errorCount: record.errorCount, createdAt: record.createdAt, rolledBackAt: record.rolledBackAt ?? null, rollbackReason: record.rollbackReason ?? null };
  await upsert(db, schema.importBatches, values, schema.importBatches.id, values);
  return record;
};
export const saveServerEurLine = async (db: PostgresQueryable, record: ServerEurLineRecord): Promise<ServerEurLineRecord> => {
  const values = { id: record.id, taxYear: record.taxYear, kennziffer: record.kennziffer ?? null, label: record.label, kind: record.kind, exportable: record.exportable, sortOrder: record.sortOrder, computedFromJson: record.computedFromJson ?? null, sourceVersion: record.sourceVersion, createdAt: record.createdAt, updatedAt: record.updatedAt };
  await upsert(db, schema.eurLines, values, schema.eurLines.id, values);
  return record;
};
export const saveServerEurClassification = async (db: PostgresQueryable, record: ServerEurClassificationRecord): Promise<ServerEurClassificationRecord> => {
  const values = { id: record.id, tenantId: record.tenantId, sourceType: record.sourceType, sourceId: record.sourceId, taxYear: record.taxYear, eurLineId: record.eurLineId ?? null, excluded: record.excluded, vatMode: record.vatMode, note: record.note ?? null, updatedAt: record.updatedAt };
  await upsert(db, schema.eurClassifications, values, schema.eurClassifications.id, values);
  return record;
};
export const saveServerEurRule = async (db: PostgresQueryable, record: ServerEurRuleRecord): Promise<ServerEurRuleRecord> => {
  const values = { id: record.id, tenantId: record.tenantId, taxYear: record.taxYear, priority: record.priority, field: record.field, operator: record.operator, value: record.value, targetEurLineId: record.targetEurLineId, active: record.active, createdAt: record.createdAt, updatedAt: record.updatedAt };
  await upsert(db, schema.eurRules, values, schema.eurRules.id, values);
  return record;
};
export const createPostgresProWorkflowRepository = (
  db: PostgresQueryable,
): ProWorkflowRepository => ({
  async list(scope) {
    const tenantId = getTenantId(scope);
    const rows = await drizzleDb(db).select().from(schema.proWorkflowEntries)
      .where(eq(schema.proWorkflowEntries.tenantId, tenantId))
      .orderBy(desc(schema.proWorkflowEntries.updatedAt), asc(schema.proWorkflowEntries.transactionId));
    return rows.map((row) => ({
      transactionId: row.transactionId!, transactionJson: row.transactionJson!, draftJson: row.draftJson!, updatedAt: row.updatedAt!,
    }));
  },

  async upsert(scope, args) {
    await saveServerProWorkflowEntry(db, {
      tenantId: getTenantId(scope),
      transactionId: args.transactionId,
      transactionJson: args.transactionJson,
      draftJson: args.draftJson,
      updatedAt: nowIso(),
    });
    return { ok: true };
  },
});

export const createPostgresProAccountingCatalogRepository = (
  db: PostgresQueryable,
): ProAccountingCatalogRepository => ({
  async listLedgerAccounts(scope, args = {}) {
    const tenantId = getTenantId(scope);
    const limit = Math.max(1, Math.min(10_000, Math.floor(args.limit ?? 500)));
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const conditions = [];
    if (args.chart) conditions.push(eq(schema.ledgerAccounts.chart, args.chart));
    if (args.search?.trim()) {
      const search = `%${args.search.trim()}%`;
      conditions.push(or(ilike(schema.ledgerAccounts.accountNumber, search), ilike(schema.ledgerAccounts.name, search))!);
    }
    const rows = await drizzleDb(db).select().from(schema.ledgerAccounts)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(schema.ledgerAccounts.chart), asc(schema.ledgerAccounts.accountNumber)).limit(limit).offset(offset);
    const filtered = rows;
    const keywords = await drizzleDb(db).select().from(schema.accountKeywords)
      .where(and(eq(schema.accountKeywords.tenantId, tenantId), eq(schema.accountKeywords.active, true))).orderBy(asc(schema.accountKeywords.keyword));
    const keywordMap = new Map<string, string[]>();
    for (const keyword of keywords) keywordMap.set(`${keyword.chart}:${keyword.accountNumber}`, [...(keywordMap.get(`${keyword.chart}:${keyword.accountNumber}`) ?? []), keyword.keyword!]);
    return filtered.map((row) => ({
    id: row.id!,
      chart: row.chart as LedgerAccount['chart'], accountNumber: row.accountNumber!, name: row.name!,
      keywords: keywordMap.get(`${row.chart}:${row.accountNumber}`), source: row.source!, createdAt: row.createdAt!, updatedAt: row.updatedAt!,
    }));
  },

  async getLedgerStats() {
    const result = await drizzleDb(db).select({ chart: schema.ledgerAccounts.chart, count: count() }).from(schema.ledgerAccounts).groupBy(schema.ledgerAccounts.chart);
    const byChart: LedgerAccountStats['byChart'] = { SKR03: 0, SKR04: 0 };
    for (const row of result) {
      if (row.chart === 'SKR03' || row.chart === 'SKR04') {
        byChart[row.chart] = Number(row.count);
      }
    }
    return {
      total: byChart.SKR03 + byChart.SKR04,
      byChart,
    };
  },

  async listTaxCases(_scope, args = {}) {
    const rows = await drizzleDb(db).select().from(schema.taxCases)
      .where(args.activeOnly ? eq(schema.taxCases.active, true) : undefined).orderBy(asc(schema.taxCases.key));
    return rows.map((row) => ({
      key: row.key as TaxCaseDefinition['key'], label: row.label!, mechanism: row.mechanism as TaxCaseDefinition['mechanism'],
      defaultRate: toNumber(row.defaultRate!), requiresCounterpartyVatId: Boolean(row.requiresCounterpartyVatId),
      requiresCountry: Boolean(row.requiresCountry), requiresEvidence: Boolean(row.requiresEvidence), active: Boolean(row.active),
    }));
  },

  async listTaxCaseAccountMappings(_scope, args = {}) {
    const conditions = [];
    if (args.chart) conditions.push(eq(schema.taxCaseAccountMappings.chart, args.chart));
    if (args.taxCaseKey) conditions.push(eq(schema.taxCaseAccountMappings.taxCaseKey, args.taxCaseKey));
    const rows = await drizzleDb(db).select().from(schema.taxCaseAccountMappings)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(schema.taxCaseAccountMappings.chart), asc(schema.taxCaseAccountMappings.taxCaseKey), asc(schema.taxCaseAccountMappings.role));
    return rows.map((row) => ({
      id: row.id!, chart: row.chart as TaxCaseAccountMapping['chart'], taxCaseKey: row.taxCaseKey as TaxCaseAccountMapping['taxCaseKey'],
      role: row.role as TaxCaseAccountMapping['role'], accountNumber: row.accountNumber!, datevBuKey: row.datevBuKey ?? undefined,
      validFrom: row.validFrom ?? undefined, validTo: row.validTo ?? undefined, updatedAt: row.updatedAt!,
    }));
  },

  async upsertTaxCaseAccountMapping(_scope, args) {
    const existing = await drizzleDb(db).select({ id: schema.taxCaseAccountMappings.id }).from(schema.taxCaseAccountMappings)
      .where(and(eq(schema.taxCaseAccountMappings.chart, args.chart), eq(schema.taxCaseAccountMappings.taxCaseKey, args.taxCaseKey), eq(schema.taxCaseAccountMappings.role, args.role))).limit(1);
    const mapping: TaxCaseAccountMapping = {
      id: args.id ?? existing[0]?.id ?? randomUUID(),
      chart: args.chart,
      taxCaseKey: args.taxCaseKey,
      role: args.role,
      accountNumber: args.accountNumber,
      datevBuKey: args.datevBuKey,
      validFrom: args.validFrom,
      validTo: args.validTo,
      updatedAt: nowIso(),
    };
    return saveServerTaxCaseAccountMapping(db, mapping);
  },

  async listAccountSuggestionRules(scope, args = {}) {
    const tenantId = getTenantId(scope);
    const conditions = [eq(schema.accountSuggestionRules.tenantId, tenantId)];
    if (args.chart) conditions.push(eq(schema.accountSuggestionRules.chart, args.chart));
    if (args.activeOnly) conditions.push(eq(schema.accountSuggestionRules.active, true));
    const rows = await drizzleDb(db).select().from(schema.accountSuggestionRules).where(and(...conditions))
      .orderBy(asc(schema.accountSuggestionRules.chart), asc(schema.accountSuggestionRules.priority), asc(schema.accountSuggestionRules.createdAt));
    return rows.map((row) => ({
      id: row.id!, tenantId: row.tenantId!, chart: row.chart as TaxCaseAccountMapping['chart'], priority: row.priority!,
      field: row.field as AccountSuggestionRuleField, operator: row.operator as AccountSuggestionRuleOperator, value: row.value!,
      targetAccountNumber: row.targetAccountNumber!, flowType: row.flowType as AccountSuggestionRuleFlowType, active: Boolean(row.active),
      createdAt: row.createdAt!, updatedAt: row.updatedAt!,
    }));
  },

  async upsertAccountSuggestionRule(scope, input) {
    const tenantId = input.tenantId ?? getTenantId(scope);
    const now = nowIso();
    const existing = input.id ? await drizzleDb(db).select({ createdAt: schema.accountSuggestionRules.createdAt }).from(schema.accountSuggestionRules)
      .where(eq(schema.accountSuggestionRules.id, input.id)).limit(1) : [];
    const rule: AccountSuggestionRule = {
      id: input.id ?? randomUUID(),
      tenantId,
      chart: input.chart,
      priority: input.priority,
      field: input.field,
      operator: input.operator,
      value: input.value.trim(),
      targetAccountNumber: input.targetAccountNumber.trim(),
      flowType: input.flowType ?? 'any',
      active: input.active !== false,
      createdAt: existing[0]?.createdAt ?? now,
      updatedAt: now,
    };
    return saveServerAccountSuggestionRule(db, rule);
  },

  async deleteAccountSuggestionRule(scope, id) {
    await drizzleDb(db).delete(schema.accountSuggestionRules).where(and(eq(schema.accountSuggestionRules.tenantId, getTenantId(scope)), eq(schema.accountSuggestionRules.id, id)));
  },
});
