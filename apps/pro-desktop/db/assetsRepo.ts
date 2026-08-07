import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, asc, count, eq } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import {
  buildDepreciationSchedule,
  computeAssetDisposal,
  DEPRECIATION_EXPENSE_ACCOUNTS,
  resolveDepreciationMethod,
  type DepreciationMethod,
} from '@billme/accounting-engine';
import type { TenantScope } from '@billme/server-core';
import { appendAuditLog } from './audit';
import { postDraft, saveDraft, type BookingDraftEntity } from './proAccountingRepo';
import { ensureTaxCaseSeedData } from './taxCasesRepo';
import { getTenantId } from '../tenantScope';

export type AssetStatus = 'entwurf' | 'aktiv' | 'voll_abgeschrieben' | 'verkauft' | 'stillgelegt';

export interface AssetRecord {
  id: string;
  assetNumber: string;
  name: string;
  assetClass: string;
  status: AssetStatus;
  activationDate: string;
  acquisitionCost: number;
  residualValue: number;
  annualDepreciation: number;
  usefulLifeYears?: number;
  depreciationMethod: DepreciationMethod;
  costCenter: string;
  location: string;
  nextDepreciation: string;
  receiptLinked: boolean;
  supplier?: string;
  invoiceRef?: string;
  assetAccountNumber: string;
  disposalDate?: string;
  disposalProceeds?: number;
}

export interface AssetUpsertInput extends Omit<
  AssetRecord,
  'id' | 'residualValue' | 'annualDepreciation' | 'nextDepreciation' | 'disposalDate' | 'disposalProceeds'
> {
  id?: string;
}

export interface AssetScheduleEntry {
  id: string;
  assetId: string;
  year: number;
  amount: number;
  months: number;
  status: 'planned' | 'posted';
  journalEntryId?: string;
  postedAt?: string;
}

type AssetRow = {
  id: string;
  asset_number: string;
  name: string;
  asset_class: string;
  status: AssetStatus;
  activation_date: string;
  acquisition_cost: number;
  useful_life_years: number | null;
  depreciation_method: DepreciationMethod;
  cost_center: string;
  location: string;
  receipt_linked: number;
  supplier: string | null;
  invoice_ref: string | null;
  asset_account_number: string;
  disposal_date: string | null;
  disposal_proceeds: number | null;
};

const scheduleInput = (row: AssetRow | AssetUpsertInput) => ({
  acquisitionCost: Number('acquisition_cost' in row ? row.acquisition_cost : row.acquisitionCost),
  activationDate: 'activation_date' in row ? row.activation_date : row.activationDate,
  assetClass: 'asset_class' in row ? row.asset_class : row.assetClass,
  usefulLifeYears: ('useful_life_years' in row ? row.useful_life_years : row.usefulLifeYears) ?? undefined,
  method: ('depreciation_method' in row ? row.depreciation_method : row.depreciationMethod),
});

const getAssetRow = (db: Database.Database, tenantId: string, assetId: string): AssetRow => {
  const row = createDrizzle(db).select({
    id: schema.assets.id, asset_number: schema.assets.assetNumber, name: schema.assets.name,
    asset_class: schema.assets.assetClass, status: schema.assets.status, activation_date: schema.assets.activationDate,
    acquisition_cost: schema.assets.acquisitionCost, useful_life_years: schema.assets.usefulLifeYears,
    depreciation_method: schema.assets.depreciationMethod, cost_center: schema.assets.costCenter,
    location: schema.assets.location, receipt_linked: schema.assets.receiptLinked, supplier: schema.assets.supplier,
    invoice_ref: schema.assets.invoiceRef, asset_account_number: schema.assets.assetAccountNumber,
    disposal_date: schema.assets.disposalDate, disposal_proceeds: schema.assets.disposalProceeds,
  }).from(schema.assets)
    .where(and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, assetId))).get() as AssetRow | undefined;
  if (!row) throw new Error('Asset not found');
  return row;
};

export const getDepreciationSchedule = (
  db: Database.Database,
  assetId: string,
  scope: TenantScope,
): AssetScheduleEntry[] => {
  const tenantId = getTenantId(scope);
  return createDrizzle(db).select().from(schema.assetDepreciationSchedule)
    .where(and(eq(schema.assetDepreciationSchedule.tenantId, tenantId), eq(schema.assetDepreciationSchedule.assetId, assetId)))
    .orderBy(asc(schema.assetDepreciationSchedule.year)).all().map((row) => ({
    id: row.id,
    assetId: row.assetId,
    year: row.year,
    amount: Number(row.amount),
    months: row.months,
    status: row.status as 'planned' | 'posted',
    journalEntryId: row.journalEntryId ?? undefined,
    postedAt: row.postedAt ?? undefined,
  }));
};

const mapAsset = (db: Database.Database, row: AssetRow, scope: TenantScope): AssetRecord => {
  const schedule = getDepreciationSchedule(db, row.id, scope);
  const posted = schedule
    .filter((period) => period.status === 'posted')
    .reduce((sum, period) => sum + period.amount, 0);
  const disposal = row.disposal_date
    ? computeAssetDisposal({
        ...scheduleInput(row),
        disposalDate: row.disposal_date,
        proceeds: Number(row.disposal_proceeds ?? 0),
      })
    : null;
  const residualValue = disposal?.residualBookValue
    ?? Math.max(0, Math.round((Number(row.acquisition_cost) - posted) * 100) / 100);
  const next = schedule.find((period) => period.status === 'planned');
  return {
    id: row.id,
    assetNumber: row.asset_number,
    name: row.name,
    assetClass: row.asset_class,
    status: row.status === 'aktiv' && residualValue === 0 ? 'voll_abgeschrieben' : row.status,
    activationDate: row.activation_date,
    acquisitionCost: Number(row.acquisition_cost),
    residualValue,
    annualDepreciation: Math.max(0, ...schedule.map((period) => period.amount)),
    usefulLifeYears: row.useful_life_years ?? undefined,
    depreciationMethod: row.depreciation_method,
    costCenter: row.cost_center,
    location: row.location,
    nextDepreciation: next ? `${next.year}-12-31` : '—',
    receiptLinked: Boolean(row.receipt_linked),
    supplier: row.supplier ?? undefined,
    invoiceRef: row.invoice_ref ?? undefined,
    assetAccountNumber: row.asset_account_number,
    disposalDate: row.disposal_date ?? undefined,
    disposalProceeds: row.disposal_proceeds === null ? undefined : Number(row.disposal_proceeds),
  };
};

export const listAssets = (db: Database.Database, scope: TenantScope): AssetRecord[] => {
  const tenantId = getTenantId(scope);
  return createDrizzle(db).select({
    id: schema.assets.id, asset_number: schema.assets.assetNumber, name: schema.assets.name,
    asset_class: schema.assets.assetClass, status: schema.assets.status, activation_date: schema.assets.activationDate,
    acquisition_cost: schema.assets.acquisitionCost, useful_life_years: schema.assets.usefulLifeYears,
    depreciation_method: schema.assets.depreciationMethod, cost_center: schema.assets.costCenter,
    location: schema.assets.location, receipt_linked: schema.assets.receiptLinked, supplier: schema.assets.supplier,
    invoice_ref: schema.assets.invoiceRef, asset_account_number: schema.assets.assetAccountNumber,
    disposal_date: schema.assets.disposalDate, disposal_proceeds: schema.assets.disposalProceeds,
  }).from(schema.assets)
    .where(eq(schema.assets.tenantId, tenantId)).orderBy(asc(schema.assets.assetNumber)).all()
    .map((row) => mapAsset(db, row as AssetRow, scope));
};

export const upsertAsset = (
  db: Database.Database,
  input: AssetUpsertInput,
  reason: string,
  scope: TenantScope,
): AssetRecord => {
  const tenantId = getTenantId(scope);
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  const method = resolveDepreciationMethod(scheduleInput(input));
  const schedule = buildDepreciationSchedule({ ...scheduleInput(input), method });
  const existing = createDrizzle(db).select({ id: schema.assets.id }).from(schema.assets)
    .where(and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, id))).get();

  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    drizzle.insert(schema.assets).values({
      id, tenantId, assetNumber: input.assetNumber, name: input.name, assetClass: input.assetClass,
      status: input.status, activationDate: input.activationDate, acquisitionCost: input.acquisitionCost,
      usefulLifeYears: input.usefulLifeYears ?? null, depreciationMethod: method, costCenter: input.costCenter,
      location: input.location, receiptLinked: input.receiptLinked ? 1 : 0, supplier: input.supplier ?? null,
      invoiceRef: input.invoiceRef ?? null, assetAccountNumber: input.assetAccountNumber, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({ target: schema.assets.id, set: {
      assetNumber: input.assetNumber, name: input.name, assetClass: input.assetClass, status: input.status,
      activationDate: input.activationDate, acquisitionCost: input.acquisitionCost,
      usefulLifeYears: input.usefulLifeYears ?? null, depreciationMethod: method, costCenter: input.costCenter,
      location: input.location, receiptLinked: input.receiptLinked ? 1 : 0, supplier: input.supplier ?? null,
      invoiceRef: input.invoiceRef ?? null, assetAccountNumber: input.assetAccountNumber, updatedAt: now,
    }}).run();

    drizzle.delete(schema.assetDepreciationSchedule).where(and(
      eq(schema.assetDepreciationSchedule.tenantId, tenantId), eq(schema.assetDepreciationSchedule.assetId, id),
      eq(schema.assetDepreciationSchedule.status, 'planned'),
    )).run();
    schedule.forEach((period) => {
      drizzle.insert(schema.assetDepreciationSchedule).values({ id: randomUUID(), tenantId, assetId: id,
        year: period.year, amount: period.amount, months: period.months, status: 'planned' })
        .onConflictDoNothing().run();
    });
    if (!existing) {
      drizzle.insert(schema.assetMovements).values({ id: randomUUID(), tenantId, assetId: id, type: 'activation',
        movementDate: input.activationDate, amount: input.acquisitionCost, proceeds: null, gainLoss: null, reason, createdAt: now }).run();
    }
    appendAuditLog(db, {
      entityType: 'asset',
      entityId: id,
      action: existing ? 'update' : 'create',
      reason,
      before: existing ?? null,
      after: input,
      actor: 'pro',
    });
  });
  tx();
  return mapAsset(db, getAssetRow(db, tenantId, id), scope);
};

const activeChart = (db: Database.Database): 'SKR03' | 'SKR04' => {
  const rows = createDrizzle(db).select({ chart: schema.ledgerAccounts.chart, count: count() })
    .from(schema.ledgerAccounts).groupBy(schema.ledgerAccounts.chart).all() as Array<{ chart: 'SKR03' | 'SKR04'; count: number }>;
  const counts = Object.fromEntries(rows.map((row) => [row.chart, row.count]));
  return Number(counts.SKR04 ?? 0) > Number(counts.SKR03 ?? 0) ? 'SKR04' : 'SKR03';
};

export const runDepreciation = (
  db: Database.Database,
  args: { assetId: string; year: number; postingDate: string; reason: string },
  scope: TenantScope,
): { asset: AssetRecord; scheduleEntry: AssetScheduleEntry; journalEntryId: string } => {
  // Posting requires canonical tax cases even on first-run/import paths that
  // have only executed schema migrations so far.
  ensureTaxCaseSeedData(db);
  const tenantId = getTenantId(scope);
  const asset = getAssetRow(db, tenantId, args.assetId);
  const period = args.postingDate.slice(0, 7);
  const periodRow = createDrizzle(db).select({ status: schema.accountingPeriods.status }).from(schema.accountingPeriods)
    .where(and(eq(schema.accountingPeriods.tenantId, tenantId), eq(schema.accountingPeriods.period, period))).get() as { status: string } | undefined;
  if (periodRow && periodRow.status !== 'open') {
    appendAuditLog(db, {
      entityType: 'asset',
      entityId: asset.id,
      action: 'depreciation_blocked',
      reason: args.reason,
      before: null,
      after: { period, status: periodRow.status },
      actor: 'pro',
    });
    throw new Error(`Depreciation is blocked in ${periodRow.status} period ${period}`);
  }

  const schedule = getDepreciationSchedule(db, asset.id, scope);
  const scheduleEntry = schedule.find((entry) => entry.year === args.year);
  if (!scheduleEntry) throw new Error('Depreciation schedule entry not found');
  if (scheduleEntry.status === 'posted') throw new Error('Depreciation already posted');

  const expenseAccount = DEPRECIATION_EXPENSE_ACCOUNTS[activeChart(db)];
  const draftId = `asset-depreciation:${asset.id}:${args.year}`;
  const draft: BookingDraftEntity = {
    id: draftId,
    tenantId,
    transactionId: draftId,
    workflowStatus: 'approved',
    postingDate: args.postingDate,
    documentDate: args.postingDate,
    bookingText: `AfA ${asset.asset_number} ${args.year}`,
    reference: asset.asset_number,
    period,
    fiscalYear: Number(period.slice(0, 4)),
    lines: [
      {
        id: randomUUID(),
        accountNumber: expenseAccount,
        debitAmount: scheduleEntry.amount,
        creditAmount: 0,
        taxCaseKey: 'DE_ZERO_EXEMPT',
        evidenceType: 'asset_depreciation',
        evidenceReference: asset.invoice_ref ?? asset.asset_number,
        costCenter: asset.cost_center,
        memo: args.reason,
      },
      {
        id: randomUUID(),
        accountNumber: asset.asset_account_number,
        debitAmount: 0,
        creditAmount: scheduleEntry.amount,
        costCenter: asset.cost_center,
        memo: args.reason,
      },
    ],
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };

  let journalEntryId = '';
  const tx = db.transaction(() => {
    saveDraft(db, draft, scope);
    const posted = postDraft(db, draftId, { postingDate: args.postingDate }, scope);
    if (posted.issues.some((issue) => issue.blocking) || !posted.entry.id) {
      throw new Error(posted.issues.map((issue) => issue.message).join('; ') || 'Depreciation posting failed');
    }
    journalEntryId = posted.entry.id;
    const postedAt = new Date().toISOString();
    const drizzle = createDrizzle(db);
    drizzle.update(schema.assetDepreciationSchedule).set({ status: 'posted', journalEntryId, postedAt })
      .where(and(eq(schema.assetDepreciationSchedule.tenantId, tenantId), eq(schema.assetDepreciationSchedule.id, scheduleEntry.id))).run();
    drizzle.insert(schema.assetMovements).values({ id: randomUUID(), tenantId, assetId: asset.id, type: 'depreciation',
      movementDate: args.postingDate, amount: scheduleEntry.amount, proceeds: null, gainLoss: null, reason: args.reason, createdAt: postedAt }).run();
    appendAuditLog(db, {
      entityType: 'asset',
      entityId: asset.id,
      action: 'depreciation_posted',
      reason: args.reason,
      before: null,
      after: { year: args.year, amount: scheduleEntry.amount, journalEntryId },
      actor: 'pro',
    });
  });
  tx();

  return {
    asset: mapAsset(db, getAssetRow(db, tenantId, asset.id), scope),
    scheduleEntry: getDepreciationSchedule(db, asset.id, scope)
      .find((entry) => entry.year === args.year)!,
    journalEntryId,
  };
};

export const disposeAsset = (
  db: Database.Database,
  args: { assetId: string; disposalDate: string; proceeds: number; reason: string },
  scope: TenantScope,
): { asset: AssetRecord; residualBookValue: number; gainLoss: number } => {
  const tenantId = getTenantId(scope);
  const row = getAssetRow(db, tenantId, args.assetId);
  const result = computeAssetDisposal({
    ...scheduleInput(row),
    disposalDate: args.disposalDate,
    proceeds: args.proceeds,
  });
  const now = new Date().toISOString();
  const status: AssetStatus = args.proceeds > 0 ? 'verkauft' : 'stillgelegt';
  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    drizzle.update(schema.assets).set({ status, disposalDate: args.disposalDate, disposalProceeds: args.proceeds, updatedAt: now })
      .where(and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, row.id))).run();
    drizzle.insert(schema.assetMovements).values({ id: randomUUID(), tenantId, assetId: row.id, type: 'disposal',
      movementDate: args.disposalDate, amount: result.residualBookValue, proceeds: args.proceeds, gainLoss: result.gainLoss, reason: args.reason, createdAt: now }).run();
    appendAuditLog(db, {
      entityType: 'asset',
      entityId: row.id,
      action: 'dispose',
      reason: args.reason,
      before: { status: row.status },
      after: { status, ...result, disposalDate: args.disposalDate },
      actor: 'pro',
    });
  });
  tx();
  return {
    asset: mapAsset(db, getAssetRow(db, tenantId, row.id), scope),
    residualBookValue: result.residualBookValue,
    gainLoss: result.gainLoss,
  };
};
