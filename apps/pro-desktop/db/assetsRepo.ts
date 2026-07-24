import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
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
  const row = db.prepare('SELECT * FROM assets WHERE tenant_id = ? AND id = ?').get(tenantId, assetId) as
    | AssetRow
    | undefined;
  if (!row) throw new Error('Asset not found');
  return row;
};

export const getDepreciationSchedule = (
  db: Database.Database,
  assetId: string,
  scope: TenantScope,
): AssetScheduleEntry[] => {
  const tenantId = getTenantId(scope);
  return (db.prepare(
    `SELECT id, asset_id, year, amount, months, status, journal_entry_id, posted_at
     FROM asset_depreciation_schedule
     WHERE tenant_id = ? AND asset_id = ?
     ORDER BY year ASC`,
  ).all(tenantId, assetId) as Array<{
    id: string;
    asset_id: string;
    year: number;
    amount: number;
    months: number;
    status: 'planned' | 'posted';
    journal_entry_id: string | null;
    posted_at: string | null;
  }>).map((row) => ({
    id: row.id,
    assetId: row.asset_id,
    year: row.year,
    amount: Number(row.amount),
    months: row.months,
    status: row.status,
    journalEntryId: row.journal_entry_id ?? undefined,
    postedAt: row.posted_at ?? undefined,
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
  return (db.prepare(
    'SELECT * FROM assets WHERE tenant_id = ? ORDER BY asset_number ASC',
  ).all(tenantId) as AssetRow[]).map((row) => mapAsset(db, row, scope));
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
  const existing = db.prepare('SELECT id FROM assets WHERE tenant_id = ? AND id = ?').get(tenantId, id);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO assets (
        id, tenant_id, asset_number, name, asset_class, status, activation_date, acquisition_cost,
        useful_life_years, depreciation_method, cost_center, location, receipt_linked, supplier,
        invoice_ref, asset_account_number, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        asset_number = excluded.asset_number,
        name = excluded.name,
        asset_class = excluded.asset_class,
        status = excluded.status,
        activation_date = excluded.activation_date,
        acquisition_cost = excluded.acquisition_cost,
        useful_life_years = excluded.useful_life_years,
        depreciation_method = excluded.depreciation_method,
        cost_center = excluded.cost_center,
        location = excluded.location,
        receipt_linked = excluded.receipt_linked,
        supplier = excluded.supplier,
        invoice_ref = excluded.invoice_ref,
        asset_account_number = excluded.asset_account_number,
        updated_at = excluded.updated_at`,
    ).run(
      id,
      tenantId,
      input.assetNumber,
      input.name,
      input.assetClass,
      input.status,
      input.activationDate,
      input.acquisitionCost,
      input.usefulLifeYears ?? null,
      method,
      input.costCenter,
      input.location,
      input.receiptLinked ? 1 : 0,
      input.supplier ?? null,
      input.invoiceRef ?? null,
      input.assetAccountNumber,
      now,
      now,
    );

    db.prepare(
      "DELETE FROM asset_depreciation_schedule WHERE tenant_id = ? AND asset_id = ? AND status = 'planned'",
    ).run(tenantId, id);
    const insertSchedule = db.prepare(
      `INSERT OR IGNORE INTO asset_depreciation_schedule
        (id, tenant_id, asset_id, year, amount, months, status)
       VALUES (?, ?, ?, ?, ?, ?, 'planned')`,
    );
    schedule.forEach((period) => {
      insertSchedule.run(randomUUID(), tenantId, id, period.year, period.amount, period.months);
    });
    if (!existing) {
      db.prepare(
        `INSERT INTO asset_movements
          (id, tenant_id, asset_id, type, movement_date, amount, reason, created_at)
         VALUES (?, ?, ?, 'activation', ?, ?, ?, ?)`,
      ).run(randomUUID(), tenantId, id, input.activationDate, input.acquisitionCost, reason, now);
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
  const rows = db.prepare('SELECT chart, COUNT(*) AS count FROM ledger_accounts GROUP BY chart').all() as Array<{
    chart: 'SKR03' | 'SKR04';
    count: number;
  }>;
  const counts = Object.fromEntries(rows.map((row) => [row.chart, row.count]));
  return Number(counts.SKR04 ?? 0) > Number(counts.SKR03 ?? 0) ? 'SKR04' : 'SKR03';
};

export const runDepreciation = (
  db: Database.Database,
  args: { assetId: string; year: number; postingDate: string; reason: string },
  scope: TenantScope,
): { asset: AssetRecord; scheduleEntry: AssetScheduleEntry; journalEntryId: string } => {
  const tenantId = getTenantId(scope);
  const asset = getAssetRow(db, tenantId, args.assetId);
  const period = args.postingDate.slice(0, 7);
  const periodRow = db.prepare(
    'SELECT status FROM accounting_periods WHERE tenant_id = ? AND period = ?',
  ).get(tenantId, period) as { status: string } | undefined;
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
    db.prepare(
      `UPDATE asset_depreciation_schedule
       SET status = 'posted', journal_entry_id = ?, posted_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(journalEntryId, postedAt, tenantId, scheduleEntry.id);
    db.prepare(
      `INSERT INTO asset_movements
        (id, tenant_id, asset_id, type, movement_date, amount, reason, created_at)
       VALUES (?, ?, ?, 'depreciation', ?, ?, ?, ?)`,
    ).run(randomUUID(), tenantId, asset.id, args.postingDate, scheduleEntry.amount, args.reason, postedAt);
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
    db.prepare(
      `UPDATE assets
       SET status = ?, disposal_date = ?, disposal_proceeds = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(status, args.disposalDate, args.proceeds, now, tenantId, row.id);
    db.prepare(
      `INSERT INTO asset_movements
        (id, tenant_id, asset_id, type, movement_date, amount, proceeds, gain_loss, reason, created_at)
       VALUES (?, ?, ?, 'disposal', ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      tenantId,
      row.id,
      args.disposalDate,
      result.residualBookValue,
      args.proceeds,
      result.gainLoss,
      args.reason,
      now,
    );
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
