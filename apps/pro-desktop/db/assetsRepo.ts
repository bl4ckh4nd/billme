import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { and, asc, eq } from "drizzle-orm";
import { createDrizzle, schema } from "@billme/desktop-data/drizzle";
import {
  buildDepreciationSchedule,
  DEPRECIATION_EXPENSE_ACCOUNTS,
  resolveDepreciationMethod,
  type DepreciationMethod,
} from "@billme/accounting-engine";
import type { TaxCaseKey } from "@billme/accounting-shared";
import type { TenantScope } from "@billme/server-core";
import { appendAuditLog } from "./audit";
import {
  postDraft,
  saveDraft,
  type BookingDraftEntity,
} from "./proAccountingRepo";
import { ensureTaxCaseSeedData } from "./taxCasesRepo";
import { getTenantId } from "../tenantScope";

export type AssetStatus =
  "entwurf" | "aktiv" | "voll_abgeschrieben" | "verkauft" | "stillgelegt";
export type AssetScheduleStatus = "planned" | "posted" | "cancelled";

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
  acquisitionOffsetAccountNumber?: string;
  sourceIncomingInvoiceId?: string;
  activationJournalEntryId?: string;
  accountingRepairRequired?: boolean;
  accountingRepairReason?: string;
  disposalDate?: string;
  disposalProceeds?: number;
}

export interface AssetUpsertInput extends Omit<
  AssetRecord,
  | "id"
  | "residualValue"
  | "annualDepreciation"
  | "nextDepreciation"
  | "disposalDate"
  | "disposalProceeds"
  | "accountingRepairRequired"
  | "accountingRepairReason"
> {
  id?: string;
  softLockOverride?: boolean;
  overrideReason?: string;
}

export interface AssetScheduleEntry {
  id: string;
  assetId: string;
  year: number;
  amount: number;
  months: number;
  status: AssetScheduleStatus;
  journalEntryId?: string;
  sourceType?: string;
  sourceKey?: string;
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
  acquisition_offset_account_number: string | null;
  source_incoming_invoice_id: string | null;
  activation_journal_entry_id: string | null;
  accounting_repair_required: number;
  accounting_repair_reason: string | null;
  disposal_date: string | null;
  disposal_proceeds: number | null;
};

const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};
const requireIsoDate = (value: string, field: string): void => {
  if (!isIsoDate(value)) throw new Error(`INVALID_${field.toUpperCase()}_DATE`);
};
const cents = (value: number): number =>
  Math.round((Number(value) + Number.EPSILON) * 100);
const amount = (value: number): number => cents(value) / 100;

const scheduleInput = (row: AssetRow | AssetUpsertInput) => ({
  acquisitionCost: Number(
    "acquisition_cost" in row ? row.acquisition_cost : row.acquisitionCost,
  ),
  activationDate:
    "activation_date" in row ? row.activation_date : row.activationDate,
  assetClass: "asset_class" in row ? row.asset_class : row.assetClass,
  usefulLifeYears:
    ("useful_life_years" in row
      ? row.useful_life_years
      : row.usefulLifeYears) ?? undefined,
  method:
    "depreciation_method" in row
      ? row.depreciation_method
      : row.depreciationMethod,
});

const getAssetRow = (
  db: Database.Database,
  tenantId: string,
  assetId: string,
): AssetRow => {
  const row = createDrizzle(db)
    .select({
      id: schema.assets.id,
      asset_number: schema.assets.assetNumber,
      name: schema.assets.name,
      asset_class: schema.assets.assetClass,
      status: schema.assets.status,
      activation_date: schema.assets.activationDate,
      acquisition_cost: schema.assets.acquisitionCost,
      useful_life_years: schema.assets.usefulLifeYears,
      depreciation_method: schema.assets.depreciationMethod,
      cost_center: schema.assets.costCenter,
      location: schema.assets.location,
      receipt_linked: schema.assets.receiptLinked,
      supplier: schema.assets.supplier,
      invoice_ref: schema.assets.invoiceRef,
      asset_account_number: schema.assets.assetAccountNumber,
      acquisition_offset_account_number:
        schema.assets.acquisitionOffsetAccountNumber,
      source_incoming_invoice_id: schema.assets.sourceIncomingInvoiceId,
      activation_journal_entry_id: schema.assets.activationJournalEntryId,
      accounting_repair_required: schema.assets.accountingRepairRequired,
      accounting_repair_reason: schema.assets.accountingRepairReason,
      disposal_date: schema.assets.disposalDate,
      disposal_proceeds: schema.assets.disposalProceeds,
    })
    .from(schema.assets)
    .where(
      and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, assetId)),
    )
    .get() as AssetRow | undefined;
  if (!row) throw new Error("Asset not found");
  return row;
};

const getMovementCount = (
  db: Database.Database,
  tenantId: string,
  assetId: string,
): number =>
  Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM asset_movements WHERE tenant_id = ? AND asset_id = ?",
        )
        .get(tenantId, assetId) as { count: number }
    ).count,
  );

const getPostedScheduleCount = (
  db: Database.Database,
  tenantId: string,
  assetId: string,
): number =>
  Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM asset_depreciation_schedule WHERE tenant_id = ? AND asset_id = ? AND status = 'posted'",
        )
        .get(tenantId, assetId) as { count: number }
    ).count,
  );

const assetSnapshot = (
  row: AssetRow | AssetRecord | AssetUpsertInput,
): Record<string, unknown> => {
  if ("asset_number" in row) {
    return {
      id: row.id,
      assetNumber: row.asset_number,
      name: row.name,
      assetClass: row.asset_class,
      status: row.status,
      activationDate: row.activation_date,
      acquisitionCost: Number(row.acquisition_cost),
      usefulLifeYears: row.useful_life_years,
      depreciationMethod: row.depreciation_method,
      costCenter: row.cost_center,
      location: row.location,
      receiptLinked: Boolean(row.receipt_linked),
      supplier: row.supplier,
      invoiceRef: row.invoice_ref,
      assetAccountNumber: row.asset_account_number,
      acquisitionOffsetAccountNumber: row.acquisition_offset_account_number,
      sourceIncomingInvoiceId: row.source_incoming_invoice_id,
      activationJournalEntryId: row.activation_journal_entry_id,
      accountingRepairRequired: Boolean(row.accounting_repair_required),
      accountingRepairReason: row.accounting_repair_reason,
      disposalDate: row.disposal_date,
      disposalProceeds: row.disposal_proceeds,
    };
  }
  return {
    id: row.id ?? null,
    assetNumber: row.assetNumber,
    name: row.name,
    assetClass: row.assetClass,
    status: row.status,
    activationDate: row.activationDate,
    acquisitionCost: row.acquisitionCost,
    usefulLifeYears: row.usefulLifeYears ?? null,
    depreciationMethod: row.depreciationMethod,
    costCenter: row.costCenter,
    location: row.location,
    receiptLinked: row.receiptLinked,
    supplier: row.supplier ?? null,
    invoiceRef: row.invoiceRef ?? null,
    assetAccountNumber: row.assetAccountNumber,
    acquisitionOffsetAccountNumber: row.acquisitionOffsetAccountNumber ?? null,
    sourceIncomingInvoiceId: row.sourceIncomingInvoiceId ?? null,
    activationJournalEntryId: row.activationJournalEntryId ?? null,
    accountingRepairRequired:
      "accountingRepairRequired" in row
        ? row.accountingRepairRequired ?? false
        : false,
    accountingRepairReason:
      "accountingRepairReason" in row
        ? row.accountingRepairReason ?? null
        : null,
    disposalDate: "disposalDate" in row ? (row.disposalDate ?? null) : null,
    disposalProceeds:
      "disposalProceeds" in row ? (row.disposalProceeds ?? null) : null,
  };
};

export const getDepreciationSchedule = (
  db: Database.Database,
  assetId: string,
  scope: TenantScope,
): AssetScheduleEntry[] => {
  const tenantId = getTenantId(scope);
  return createDrizzle(db)
    .select()
    .from(schema.assetDepreciationSchedule)
    .where(
      and(
        eq(schema.assetDepreciationSchedule.tenantId, tenantId),
        eq(schema.assetDepreciationSchedule.assetId, assetId),
      ),
    )
    .orderBy(asc(schema.assetDepreciationSchedule.year))
    .all()
    .map((row) => ({
      id: row.id,
      assetId: row.assetId,
      year: row.year,
      amount: Number(row.amount),
      months: row.months,
      status: row.status as AssetScheduleStatus,
      journalEntryId: row.journalEntryId ?? undefined,
      sourceType: row.sourceType ?? undefined,
      sourceKey: row.sourceKey ?? undefined,
      postedAt: row.postedAt ?? undefined,
    }));
};

const auditSchedule = (schedule: AssetScheduleEntry[]): Record<string, unknown>[] =>
  schedule.map((entry) => ({
    id: entry.id,
    assetId: entry.assetId,
    year: entry.year,
    amount: entry.amount,
    months: entry.months,
    status: entry.status,
    journalEntryId: entry.journalEntryId ?? null,
    sourceType: entry.sourceType ?? null,
    sourceKey: entry.sourceKey ?? null,
    postedAt: entry.postedAt ?? null,
  }));

const mapAsset = (
  db: Database.Database,
  row: AssetRow,
  scope: TenantScope,
): AssetRecord => {
  const schedule = getDepreciationSchedule(db, row.id, scope);
  const posted = schedule
    .filter((period) => period.status === "posted")
    .reduce((sum, period) => sum + period.amount, 0);
  const residualValue = Math.max(0, amount(Number(row.acquisition_cost) - posted));
  const next = schedule.find((period) => period.status === "planned");
  return {
    id: row.id,
    assetNumber: row.asset_number,
    name: row.name,
    assetClass: row.asset_class,
    status:
      row.status === "aktiv" && residualValue === 0
        ? "voll_abgeschrieben"
        : row.status,
    activationDate: row.activation_date,
    acquisitionCost: Number(row.acquisition_cost),
    residualValue,
    annualDepreciation: Math.max(0, ...schedule.map((period) => period.amount)),
    usefulLifeYears: row.useful_life_years ?? undefined,
    depreciationMethod: row.depreciation_method,
    costCenter: row.cost_center,
    location: row.location,
    nextDepreciation: next ? `${next.year}-12-31` : "—",
    receiptLinked: Boolean(row.receipt_linked),
    supplier: row.supplier ?? undefined,
    invoiceRef: row.invoice_ref ?? undefined,
    assetAccountNumber: row.asset_account_number,
    acquisitionOffsetAccountNumber:
      row.acquisition_offset_account_number ?? undefined,
    sourceIncomingInvoiceId: row.source_incoming_invoice_id ?? undefined,
    activationJournalEntryId: row.activation_journal_entry_id ?? undefined,
    accountingRepairRequired: Boolean(row.accounting_repair_required),
    accountingRepairReason: row.accounting_repair_reason ?? undefined,
    disposalDate: row.disposal_date ?? undefined,
    disposalProceeds:
      row.disposal_proceeds === null
        ? undefined
        : Number(row.disposal_proceeds),
  };
};

export const listAssets = (
  db: Database.Database,
  scope: TenantScope,
): AssetRecord[] => {
  const tenantId = getTenantId(scope);
  return createDrizzle(db)
    .select({
      id: schema.assets.id,
      asset_number: schema.assets.assetNumber,
      name: schema.assets.name,
      asset_class: schema.assets.assetClass,
      status: schema.assets.status,
      activation_date: schema.assets.activationDate,
      acquisition_cost: schema.assets.acquisitionCost,
      useful_life_years: schema.assets.usefulLifeYears,
      depreciation_method: schema.assets.depreciationMethod,
      cost_center: schema.assets.costCenter,
      location: schema.assets.location,
      receipt_linked: schema.assets.receiptLinked,
      supplier: schema.assets.supplier,
      invoice_ref: schema.assets.invoiceRef,
      asset_account_number: schema.assets.assetAccountNumber,
      acquisition_offset_account_number:
        schema.assets.acquisitionOffsetAccountNumber,
      source_incoming_invoice_id: schema.assets.sourceIncomingInvoiceId,
      activation_journal_entry_id: schema.assets.activationJournalEntryId,
      accounting_repair_required: schema.assets.accountingRepairRequired,
      accounting_repair_reason: schema.assets.accountingRepairReason,
      disposal_date: schema.assets.disposalDate,
      disposal_proceeds: schema.assets.disposalProceeds,
    })
    .from(schema.assets)
    .where(eq(schema.assets.tenantId, tenantId))
    .orderBy(asc(schema.assets.assetNumber))
    .all()
    .map((row) => mapAsset(db, row as AssetRow, scope));
};

const periodStatus = (
  db: Database.Database,
  tenantId: string,
  date: string,
): string =>
  (
    db
      .prepare(
        "SELECT status FROM accounting_periods WHERE tenant_id = ? AND period = ?",
      )
      .get(tenantId, date.slice(0, 7)) as { status: string } | undefined
  )?.status ?? "open";

const assertPostingPeriod = (
  db: Database.Database,
  tenantId: string,
  date: string,
  options: { softLockOverride?: boolean; overrideReason?: string },
): void => {
  requireIsoDate(date, "posting");
  const status = periodStatus(db, tenantId, date);
  if (status === "closed") throw new Error("POSTING_DATE_IN_CLOSED_PERIOD");
  if (
    status === "soft_locked" &&
    (!options.softLockOverride || !options.overrideReason?.trim())
  )
    throw new Error("SOFT_LOCK_OVERRIDE_REQUIRED");
};

const configuredAccount = (
  db: Database.Database,
  tenantId: string,
  chart: 'SKR03' | 'SKR04',
  role: string,
): string | undefined => {
  const configured = (
    db
      .prepare(
        "SELECT account_number FROM accounting_account_mappings WHERE tenant_id = ? AND chart = ? AND role = ?",
      )
      .get(tenantId, chart, role) as { account_number: string } | undefined
  )?.account_number;
  if (configured) return configured;
  const defaults: Record<'SKR03' | 'SKR04', Record<string, string>> = {
    SKR03: { accounts_payable: '1600', bank: '1200', output_vat: '1776' },
    SKR04: { accounts_payable: '3300', bank: '1800', output_vat: '3806' },
  };
  return defaults[chart][role];
};
const accountExists = (
  db: Database.Database,
  chart: string,
  account: string,
): boolean =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM ledger_accounts WHERE chart = ? AND account_number = ?",
      )
      .get(chart, account),
  );
const taxOutputAccount = (
  db: Database.Database,
  chart: 'SKR03' | 'SKR04',
  rate: 0 | 7 | 19,
): string => {
  const taxCase = rate === 7 ? 'DE_STD_7' : 'DE_STD_19';
  const mapped = db
    .prepare(
      "SELECT account_number FROM tax_case_account_mappings WHERE chart = ? AND tax_case_key = ? AND role = 'output_tax'",
    )
    .get(chart, taxCase) as { account_number: string } | undefined;
  if (mapped?.account_number) return mapped.account_number;
  return chart === 'SKR03'
    ? rate === 7
      ? '1771'
      : '1776'
    : rate === 7
      ? '3801'
      : '3806';
};
const activeChart = (
  db: Database.Database,
  tenantId: string,
): "SKR03" | "SKR04" =>
  (
    db
      .prepare(
        "SELECT active_chart FROM accounting_policies WHERE tenant_id = ?",
      )
      .get(tenantId) as { active_chart: "SKR03" | "SKR04" } | undefined
  )?.active_chart ?? "SKR03";

const matchingPostedIncomingInvoice = (
  db: Database.Database,
  tenantId: string,
  invoiceId: string,
  assetAccount: string,
  cost: number,
): { journalEntryId: string; sourceKey: string } => {
  const invoice = db
    .prepare(
      "SELECT accounting_status, accounting_journal_entry_id FROM incoming_invoices WHERE tenant_id = ? AND id = ?",
    )
    .get(tenantId, invoiceId) as
    | { accounting_status: string; accounting_journal_entry_id: string | null }
    | undefined;
  if (
    !invoice ||
    invoice.accounting_status !== "posted" ||
    !invoice.accounting_journal_entry_id
  )
    throw new Error("INCOMING_INVOICE_NOT_POSTED");
  if (
    !db
      .prepare("SELECT 1 FROM journal_entries WHERE tenant_id = ? AND id = ?")
      .get(tenantId, invoice.accounting_journal_entry_id)
  )
    throw new Error("INCOMING_INVOICE_JOURNAL_NOT_FOUND");
  const line = db
    .prepare(
      "SELECT net_amount FROM incoming_invoice_lines WHERE tenant_id = ? AND incoming_invoice_id = ? AND asset_account_number = ? AND ABS(net_amount - ?) < 0.005 LIMIT 1",
    )
    .get(tenantId, invoiceId, assetAccount, cost) as
    { net_amount: number } | undefined;
  if (!line) throw new Error("INCOMING_INVOICE_ASSET_LINE_MISMATCH");
  return {
    journalEntryId: invoice.accounting_journal_entry_id,
    sourceKey: `incoming-invoice:${invoiceId}`,
  };
};

const postAssetJournal = (
  db: Database.Database,
  scope: TenantScope,
  args: {
    draftId: string;
    sourceType: string;
    sourceKey: string;
    postingDate: string;
    bookingText: string;
    reference: string;
    tenantId: string;
    lines: BookingDraftEntity["lines"];
    options: { softLockOverride?: boolean; overrideReason?: string };
    trustedSourceType?: string;
    inTransaction?: boolean;
  },
): string => {
  const draft: BookingDraftEntity = {
    id: args.draftId,
    tenantId: args.tenantId,
    transactionId: args.draftId,
    workflowStatus: "approved",
    postingDate: args.postingDate,
    documentDate: args.postingDate,
    bookingText: args.bookingText,
    reference: args.reference,
    period: args.postingDate.slice(0, 7),
    fiscalYear: Number(args.postingDate.slice(0, 4)),
    lines: args.lines,
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };
  saveDraft(db, draft, scope, {
    trustedSourceType: args.trustedSourceType,
    inTransaction: args.inTransaction,
  });
  const posted = postDraft(
    db,
    args.draftId,
    {
      postingDate: args.postingDate,
      idempotencyKey: args.sourceKey,
      sourceType: args.sourceType,
      softLockOverride: args.options.softLockOverride,
      overrideReason: args.options.overrideReason,
      trustedSourceType: args.trustedSourceType,
      inTransaction: args.inTransaction,
    },
    scope,
  );
  if (posted.issues.some((issue) => issue.blocking) || !posted.entry.id)
    throw new Error(
      posted.issues.map((issue) => issue.message).join("; ") ||
        "Asset posting failed",
    );
  return posted.entry.id;
};

const insertSchedule = (
  db: Database.Database,
  tenantId: string,
  assetId: string,
  schedule: ReturnType<typeof buildDepreciationSchedule>,
): void => {
  const drizzle = createDrizzle(db);
  drizzle
    .delete(schema.assetDepreciationSchedule)
    .where(
      and(
        eq(schema.assetDepreciationSchedule.tenantId, tenantId),
        eq(schema.assetDepreciationSchedule.assetId, assetId),
        eq(schema.assetDepreciationSchedule.status, "planned"),
      ),
    )
    .run();
  for (const period of schedule) {
    drizzle
      .insert(schema.assetDepreciationSchedule)
      .values({
        id: randomUUID(),
        tenantId,
        assetId,
        year: period.year,
        amount: period.amount,
        months: period.months,
        status: "planned",
        journalEntryId: null,
        sourceType: null,
        sourceKey: null,
        postedAt: null,
      })
      .onConflictDoNothing()
      .run();
  }
};

export const repairLegacyAssetActivation = (
  db: Database.Database,
  args: { assetId: string; sourceIncomingInvoiceId: string; reason: string },
  scope: TenantScope,
): AssetRecord => {
  const tenantId = getTenantId(scope);
  const row = getAssetRow(db, tenantId, args.assetId);
  if (!row.accounting_repair_required)
    throw new Error("ASSET_ACTIVATION_REPAIR_NOT_REQUIRED");
  if (!args.sourceIncomingInvoiceId?.trim())
    throw new Error("ASSET_ACTIVATION_REPAIR_SOURCE_REQUIRED");
  const linked = matchingPostedIncomingInvoice(
    db,
    tenantId,
    args.sourceIncomingInvoiceId.trim(),
    row.asset_account_number,
    row.acquisition_cost,
  );
  const existingMovement = db
    .prepare(
      "SELECT id, journal_entry_id FROM asset_movements WHERE tenant_id = ? AND asset_id = ? AND type = 'activation' ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(tenantId, row.id) as
    | { id: string; journal_entry_id: string | null }
    | undefined;
  if (existingMovement?.journal_entry_id && existingMovement.journal_entry_id !== linked.journalEntryId)
    throw new Error("ASSET_ACTIVATION_REPAIR_CONFLICT");
  const scheduleBefore = getDepreciationSchedule(db, row.id, scope);
  const now = new Date().toISOString();
  db.transaction(() => {
    if (existingMovement) {
      db.prepare(
        `UPDATE asset_movements
         SET journal_entry_id = ?, source_type = 'incoming_invoice', source_key = ?
         WHERE tenant_id = ? AND id = ?`,
      ).run(linked.journalEntryId, linked.sourceKey, tenantId, existingMovement.id);
    } else {
      createDrizzle(db)
        .insert(schema.assetMovements)
        .values({
          id: randomUUID(),
          tenantId,
          assetId: row.id,
          type: "activation",
          movementDate: row.activation_date,
          amount: amount(row.acquisition_cost),
          proceeds: null,
          gainLoss: null,
          journalEntryId: linked.journalEntryId,
          sourceType: "incoming_invoice",
          sourceKey: linked.sourceKey,
          reason: args.reason,
          createdAt: now,
        })
        .run();
    }
    createDrizzle(db)
      .update(schema.assets)
      .set({
        activationJournalEntryId: linked.journalEntryId,
        sourceIncomingInvoiceId: args.sourceIncomingInvoiceId.trim(),
        accountingRepairRequired: 0,
        accountingRepairReason: null,
        updatedAt: now,
      })
      .where(and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, row.id)))
      .run();
    insertSchedule(db, tenantId, row.id, buildDepreciationSchedule({
      ...scheduleInput(row),
      method: row.depreciation_method,
    }));
    const repaired = getAssetRow(db, tenantId, row.id);
    appendAuditLog(db, {
      entityType: "asset",
      entityId: row.id,
      action: "legacy_activation_repaired",
      reason: args.reason,
      before: {
        ...assetSnapshot(row),
        schedule: auditSchedule(scheduleBefore),
      },
      after: {
        ...assetSnapshot(repaired),
        schedule: auditSchedule(getDepreciationSchedule(db, row.id, scope)),
      },
      actor: "pro",
    });
  })();
  return mapAsset(db, getAssetRow(db, tenantId, row.id), scope);
};

export const upsertAsset = (
  db: Database.Database,
  input: AssetUpsertInput,
  reason: string,
  scope: TenantScope,
): AssetRecord => {
  const tenantId = getTenantId(scope);
  const existingByNumber = input.id
    ? undefined
    : (db
        .prepare(
          "SELECT id FROM assets WHERE tenant_id = ? AND asset_number = ?",
        )
        .get(tenantId, input.assetNumber) as { id: string } | undefined);
  const id = input.id ?? existingByNumber?.id ?? randomUUID();
  const now = new Date().toISOString();
  const method = resolveDepreciationMethod(scheduleInput(input));
  const schedule = buildDepreciationSchedule({
    ...scheduleInput(input),
    method,
  });
  const existingId = createDrizzle(db)
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, id)))
    .get()?.id;
  let existingRow = existingId ? getAssetRow(db, tenantId, id) : undefined;
  if (existingRow?.accounting_repair_required) {
    if (input.status !== "aktiv" || !input.sourceIncomingInvoiceId)
      throw new Error("ASSET_ACTIVATION_REPAIR_REQUIRED");
    repairLegacyAssetActivation(db, {
      assetId: id,
      sourceIncomingInvoiceId: input.sourceIncomingInvoiceId,
      reason,
    }, scope);
    existingRow = getAssetRow(db, tenantId, id);
  }
  const retryingActivation = Boolean(
    input.status === "aktiv" && existingRow?.activation_journal_entry_id,
  );
  if (
    existingRow &&
    (getMovementCount(db, tenantId, id) > 0 ||
      getPostedScheduleCount(db, tenantId, id) > 0)
  ) {
    const financialChanged =
      input.assetNumber !== existingRow.asset_number ||
      input.assetClass !== existingRow.asset_class ||
      input.activationDate !== existingRow.activation_date ||
      amount(input.acquisitionCost) !== amount(existingRow.acquisition_cost) ||
      (input.usefulLifeYears ?? null) !== existingRow.useful_life_years ||
      method !== existingRow.depreciation_method ||
      input.assetAccountNumber !== existingRow.asset_account_number ||
      (input.acquisitionOffsetAccountNumber !== undefined &&
        input.acquisitionOffsetAccountNumber !==
          existingRow.acquisition_offset_account_number) ||
      (input.sourceIncomingInvoiceId !== undefined &&
        input.sourceIncomingInvoiceId !== existingRow.source_incoming_invoice_id);
    if (financialChanged) throw new Error("ACCOUNTING_ASSET_FIELDS_IMMUTABLE");
  }
  if (input.status === "aktiv" && !retryingActivation)
    assertPostingPeriod(db, tenantId, input.activationDate, input);

  let activationJournalEntryId =
    existingRow?.activation_journal_entry_id ?? null;
  let acquisitionOffsetAccountNumber =
    input.acquisitionOffsetAccountNumber ??
    existingRow?.acquisition_offset_account_number ??
    null;
  const sourceIncomingInvoiceId =
    input.sourceIncomingInvoiceId !== undefined
      ? input.sourceIncomingInvoiceId
      : existingRow?.source_incoming_invoice_id ?? null;
  let activationSourceType: string | null = null;
  let activationSourceKey: string | null = null;
  const scheduleBefore = existingRow
    ? getDepreciationSchedule(db, id, scope)
    : [];
  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    drizzle
      .insert(schema.assets)
      .values({
        id,
        tenantId,
        assetNumber: input.assetNumber,
        name: input.name,
        assetClass: input.assetClass,
        status: input.status,
        activationDate: input.activationDate,
        acquisitionCost: input.acquisitionCost,
        usefulLifeYears: input.usefulLifeYears ?? null,
        depreciationMethod: method,
        costCenter: input.costCenter,
        location: input.location,
        receiptLinked: input.receiptLinked ? 1 : 0,
        supplier: input.supplier ?? null,
        invoiceRef: input.invoiceRef ?? null,
        assetAccountNumber: input.assetAccountNumber,
        acquisitionOffsetAccountNumber,
        sourceIncomingInvoiceId,
        activationJournalEntryId: activationJournalEntryId,
        disposalDate: null,
        disposalProceeds: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.assets.id,
        set: {
          assetNumber: input.assetNumber,
          name: input.name,
          assetClass: input.assetClass,
          status: input.status,
          activationDate: input.activationDate,
          acquisitionCost: input.acquisitionCost,
          usefulLifeYears: input.usefulLifeYears ?? null,
          depreciationMethod: method,
          costCenter: input.costCenter,
          location: input.location,
          receiptLinked: input.receiptLinked ? 1 : 0,
          supplier: input.supplier ?? null,
          invoiceRef: input.invoiceRef ?? null,
          assetAccountNumber: input.assetAccountNumber,
          acquisitionOffsetAccountNumber,
          sourceIncomingInvoiceId,
          updatedAt: now,
        },
      })
      .run();

    if (input.status === "aktiv" && !activationJournalEntryId) {
      const sourceKey = `asset_activation:${id}`;
      const existingMovement = db
        .prepare(
          "SELECT journal_entry_id, source_type, source_key FROM asset_movements WHERE tenant_id = ? AND asset_id = ? AND type = 'activation'",
        )
        .get(tenantId, id) as
        | {
            journal_entry_id: string | null;
            source_type: string | null;
            source_key: string | null;
          }
        | undefined;
      if (existingMovement?.journal_entry_id) {
        activationJournalEntryId = existingMovement.journal_entry_id;
        activationSourceType = existingMovement.source_type;
        activationSourceKey = existingMovement.source_key;
      } else if (sourceIncomingInvoiceId) {
        const linked = matchingPostedIncomingInvoice(
          db,
          tenantId,
          sourceIncomingInvoiceId,
          input.assetAccountNumber,
          input.acquisitionCost,
        );
        const alreadyLinked = db
          .prepare(
            "SELECT asset_id FROM asset_movements WHERE tenant_id = ? AND source_type = ? AND source_key = ?",
          )
          .get(tenantId, "incoming_invoice", linked.sourceKey) as
          | { asset_id: string }
          | undefined;
        if (alreadyLinked && alreadyLinked.asset_id !== id)
          throw new Error("INCOMING_INVOICE_ASSET_ALREADY_LINKED");
        activationJournalEntryId = linked.journalEntryId;
        activationSourceType = "incoming_invoice";
        activationSourceKey = linked.sourceKey;
      } else {
        const chart = activeChart(db, tenantId);
        const offset =
          input.acquisitionOffsetAccountNumber ||
          configuredAccount(db, tenantId, chart, "accounts_payable");
        if (!offset) throw new Error("ACQUISITION_OFFSET_ACCOUNT_REQUIRED");
        if (
          !accountExists(db, chart, input.assetAccountNumber) ||
          !accountExists(db, chart, offset)
        )
          throw new Error("ACQUISITION_ACCOUNT_NOT_IN_CHART");
        activationJournalEntryId = postAssetJournal(db, scope, {
          draftId: `asset-activation:${id}`,
          sourceType: "asset_activation",
          sourceKey,
          postingDate: input.activationDate,
          bookingText: `Anlagenzugang ${input.assetNumber}`,
          reference: input.assetNumber,
          tenantId,
          lines: [
            {
              id: `${id}-asset`,
              accountNumber: input.assetAccountNumber,
              debitAmount: amount(input.acquisitionCost),
              creditAmount: 0,
              costCenter: input.costCenter,
              memo: reason,
            },
            {
              id: `${id}-offset`,
              accountNumber: offset,
              debitAmount: 0,
              creditAmount: amount(input.acquisitionCost),
              costCenter: input.costCenter,
              memo: reason,
            },
          ],
          options: input,
          inTransaction: true,
        });
        acquisitionOffsetAccountNumber = offset;
        activationSourceType = "asset_activation";
        activationSourceKey = sourceKey;
      }
      drizzle
        .update(schema.assets)
        .set({
          activationJournalEntryId,
          acquisitionOffsetAccountNumber,
          updatedAt: now,
        })
        .where(
          and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, id)),
        )
        .run();
      drizzle
        .insert(schema.assetMovements)
        .values({
          id: randomUUID(),
          tenantId,
          assetId: id,
          type: "activation",
          movementDate: input.activationDate,
          amount: amount(input.acquisitionCost),
          proceeds: null,
          gainLoss: null,
          journalEntryId: activationJournalEntryId,
          sourceType: activationSourceType,
          sourceKey: activationSourceKey,
          reason,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
      insertSchedule(db, tenantId, id, schedule);
    } else if (input.status === "aktiv") {
      insertSchedule(db, tenantId, id, schedule);
    }

    const scheduleAfter = getDepreciationSchedule(db, id, scope);
    appendAuditLog(db, {
      entityType: "asset",
      entityId: id,
      action: existingRow ? "update" : "create",
      reason: input.overrideReason?.trim() || reason,
      before: existingRow
        ? { ...assetSnapshot(existingRow), schedule: auditSchedule(scheduleBefore) }
        : { schedule: auditSchedule(scheduleBefore) },
      after: {
        ...assetSnapshot({
          ...input,
          id,
          acquisitionOffsetAccountNumber: acquisitionOffsetAccountNumber ?? undefined,
          sourceIncomingInvoiceId: sourceIncomingInvoiceId ?? undefined,
          activationJournalEntryId: activationJournalEntryId ?? undefined,
        }),
        schedule: auditSchedule(scheduleAfter),
      },
      actor: "pro",
    });
  });
  tx();
  return mapAsset(db, getAssetRow(db, tenantId, id), scope);
};

const sourceJournalId = (
  db: Database.Database,
  tenantId: string,
  sourceType: string,
  sourceKey: string,
): string | undefined =>
  (
    db
      .prepare(
        "SELECT id FROM journal_entries WHERE tenant_id = ? AND source_type = ? AND source_key = ?",
      )
      .get(tenantId, sourceType, sourceKey) as { id: string } | undefined
  )?.id;

const postedAssetAmount = (
  db: Database.Database,
  tenantId: string,
  asset: AssetRow,
): number => {
  const schedule = db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS amount FROM asset_depreciation_schedule WHERE tenant_id = ? AND asset_id = ? AND status = 'posted'",
    )
    .get(tenantId, asset.id) as { amount: number };
  const journals = db
    .prepare(
      `SELECT COALESCE(SUM(l.credit_amount - l.debit_amount), 0) AS amount
       FROM asset_movements m
       JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
       JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.entry_id = j.id
       WHERE m.tenant_id = ? AND m.asset_id = ? AND m.type = 'depreciation'
         AND j.status = 'posted' AND j.source_type = 'asset_depreciation'
         AND l.account_number = ?`,
    )
    .get(tenantId, asset.id, asset.asset_account_number) as { amount: number };
  const scheduledCents = cents(Number(schedule.amount));
  const journalCents = cents(Number(journals.amount));
  if (scheduledCents !== journalCents)
    throw new Error("ASSET_DEPRECIATION_PROJECTION_MISMATCH");
  return Number(journals.amount);
};

const carryingAmount = (
  db: Database.Database,
  tenantId: string,
  row: AssetRow,
): number =>
  Math.max(0, amount(Number(row.acquisition_cost) - postedAssetAmount(db, tenantId, row)));

export const runDepreciation = (
  db: Database.Database,
  args: {
    assetId: string;
    year: number;
    postingDate: string;
    reason: string;
    softLockOverride?: boolean;
    overrideReason?: string;
  },
  scope: TenantScope,
): {
  asset: AssetRecord;
  scheduleEntry: AssetScheduleEntry;
  journalEntryId: string;
} => {
  const tenantId = getTenantId(scope);
  const asset = getAssetRow(db, tenantId, args.assetId);
  if (asset.accounting_repair_required)
    throw new Error("ASSET_ACTIVATION_REPAIR_REQUIRED");
  const scheduleBefore = getDepreciationSchedule(db, asset.id, scope);
  const scheduleEntry = scheduleBefore.find(
    (entry) => entry.year === args.year,
  );
  if (!scheduleEntry) throw new Error("Depreciation schedule entry not found");
  if (scheduleEntry.status === "cancelled")
    throw new Error("DEPRECIATION_SCHEDULE_CANCELLED");
  const sourceKey = `asset_depreciation:${asset.id}:${args.year}`;
  const existingJournalId =
    scheduleEntry.journalEntryId ||
    sourceJournalId(db, tenantId, "asset_depreciation", sourceKey);
  if (scheduleEntry.status === "posted" && existingJournalId)
    return {
      asset: mapAsset(db, getAssetRow(db, tenantId, asset.id), scope),
      scheduleEntry,
      journalEntryId: existingJournalId,
    };
  requireIsoDate(args.postingDate, "posting");
  if (!existingJournalId)
    assertPostingPeriod(db, tenantId, args.postingDate, args);
  if (asset.status === "entwurf" || !asset.activation_journal_entry_id)
    throw new Error("ASSET_NOT_ACTIVE");
  const chart = activeChart(db, tenantId);
  const expenseAccount = DEPRECIATION_EXPENSE_ACCOUNTS[chart];
  if (
    !accountExists(db, chart, expenseAccount) ||
    !accountExists(db, chart, asset.asset_account_number)
  )
    throw new Error("DEPRECIATION_ACCOUNT_NOT_IN_CHART");
  let journalEntryId = "";
  const postedAt = new Date().toISOString();
  db.transaction(() => {
    journalEntryId = postAssetJournal(db, scope, {
      draftId: `asset-depreciation:${asset.id}:${args.year}`,
      sourceType: "asset_depreciation",
      sourceKey,
      postingDate: args.postingDate,
      bookingText: `AfA ${asset.asset_number} ${args.year}`,
      reference: asset.asset_number,
      tenantId,
      lines: [
        {
          id: `${asset.id}-expense-${args.year}`,
          accountNumber: expenseAccount,
          debitAmount: scheduleEntry.amount,
          creditAmount: 0,
          evidenceType: "asset_depreciation",
          evidenceReference: asset.invoice_ref ?? asset.asset_number,
          costCenter: asset.cost_center,
          memo: args.reason,
        },
        {
          id: `${asset.id}-asset-${args.year}`,
          accountNumber: asset.asset_account_number,
          debitAmount: 0,
          creditAmount: scheduleEntry.amount,
          costCenter: asset.cost_center,
          memo: args.reason,
        },
      ],
      options: args,
      trustedSourceType: "asset_depreciation",
      inTransaction: true,
    });
    const drizzle = createDrizzle(db);
    drizzle
      .update(schema.assetDepreciationSchedule)
      .set({
        status: "posted",
        journalEntryId,
        sourceType: "asset_depreciation",
        sourceKey,
        postedAt,
      })
      .where(
        and(
          eq(schema.assetDepreciationSchedule.tenantId, tenantId),
          eq(schema.assetDepreciationSchedule.id, scheduleEntry.id),
        ),
      )
      .run();
    drizzle
      .insert(schema.assetMovements)
      .values({
        id: randomUUID(),
        tenantId,
        assetId: asset.id,
        type: "depreciation",
        movementDate: args.postingDate,
        amount: scheduleEntry.amount,
        proceeds: null,
        gainLoss: null,
        journalEntryId,
        sourceType: "asset_depreciation",
        sourceKey,
        reason: args.overrideReason?.trim() || args.reason,
        createdAt: postedAt,
      })
      .onConflictDoNothing()
      .run();
    const scheduleAfter = getDepreciationSchedule(db, asset.id, scope);
    const completed = scheduleAfter.length > 0 &&
      scheduleAfter.every((entry) => entry.status === "posted") &&
      amount(scheduleAfter.reduce((sum, entry) => sum + entry.amount, 0)) >= amount(asset.acquisition_cost);
    if (completed) {
      drizzle
        .update(schema.assets)
        .set({ status: "voll_abgeschrieben", updatedAt: postedAt })
        .where(and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, asset.id)))
        .run();
    }
    const assetAfter = getAssetRow(db, tenantId, asset.id);
    appendAuditLog(db, {
      entityType: "asset",
      entityId: asset.id,
      action: "depreciation_posted",
      reason: args.overrideReason?.trim() || args.reason,
      before: { schedule: auditSchedule(scheduleBefore) },
      after: {
        schedule: auditSchedule(scheduleAfter),
        asset: assetSnapshot(assetAfter),
        year: args.year,
        amount: scheduleEntry.amount,
        journalEntryId,
        sourceType: "asset_depreciation",
        sourceKey,
      },
      actor: "pro",
    });
  })();
  return {
    asset: mapAsset(db, getAssetRow(db, tenantId, asset.id), scope),
    scheduleEntry: getDepreciationSchedule(db, asset.id, scope).find(
      (entry) => entry.year === args.year,
    )!,
    journalEntryId,
  };
};

const disposalAccounts = (chart: "SKR03" | "SKR04") =>
  chart === "SKR03"
    ? { loss: "2310", gain: "8829" }
    : { loss: "6895", gain: "4849" };

export const disposeAsset = (
  db: Database.Database,
  args: {
    assetId: string;
    disposalDate: string;
    proceeds: number;
    taxRate?: 0 | 7 | 19;
    proceedsAccountNumber?: string;
    softLockOverride?: boolean;
    overrideReason?: string;
    reason: string;
  },
  scope: TenantScope,
): {
  asset: AssetRecord;
  residualBookValue: number;
  gainLoss: number;
  journalEntryId: string;
} => {
  ensureTaxCaseSeedData(db);
  const tenantId = getTenantId(scope);
  const row = getAssetRow(db, tenantId, args.assetId);
  const sourceKey = `asset_disposal:${row.id}`;
  const existingJournalId = sourceJournalId(
    db,
    tenantId,
    "asset_disposal",
    sourceKey,
  );
  const existingDisposalMovement = db
    .prepare(
      "SELECT amount, proceeds, gain_loss FROM asset_movements WHERE tenant_id = ? AND asset_id = ? AND source_type = 'asset_disposal' AND source_key = ? LIMIT 1",
    )
    .get(tenantId, row.id, sourceKey) as
    | { amount: number; proceeds: number | null; gain_loss: number | null }
    | undefined;
  if (existingJournalId && row.disposal_date && existingDisposalMovement) {
    const residualBookValue = Number(existingDisposalMovement.amount);
    const gainLoss = Number(
      existingDisposalMovement.gain_loss ??
        amount(Number(existingDisposalMovement.proceeds ?? args.proceeds) - residualBookValue),
    );
    return {
      asset: mapAsset(db, row, scope),
      residualBookValue,
      gainLoss,
      journalEntryId: existingJournalId,
    };
  }
  requireIsoDate(args.disposalDate, "disposal");
  if (!existingJournalId)
    assertPostingPeriod(db, tenantId, args.disposalDate, args);
  if (row.depreciation_method === "pool")
    throw new Error("POOL_INDIVIDUAL_DISPOSAL_NOT_SUPPORTED");
  if (row.accounting_repair_required)
    throw new Error("ASSET_ACTIVATION_REPAIR_REQUIRED");
  if (row.status === "entwurf" || !row.activation_journal_entry_id)
    throw new Error("ASSET_NOT_ACTIVE");
  if (row.disposal_date) throw new Error("ASSET_ALREADY_DISPOSED");
  if (args.proceeds > 0 && args.taxRate === undefined)
    throw new Error("TAX_RATE_REQUIRED_FOR_PROCEEDS");
  const residualBookValue = carryingAmount(db, tenantId, row);
  const gainLoss = amount(args.proceeds - residualBookValue);
  const chart = activeChart(db, tenantId);
  const accounts = disposalAccounts(chart);
  const proceedsAccount =
    args.proceedsAccountNumber ||
    configuredAccount(db, tenantId, chart, "bank");
  if (args.proceeds > 0 && !proceedsAccount)
    throw new Error("PROCEEDS_ACCOUNT_REQUIRED");
  const accountNumbers = [
    row.asset_account_number,
    accounts.loss,
    accounts.gain,
    ...(args.proceeds > 0 && proceedsAccount ? [proceedsAccount] : []),
  ];
  if (args.proceeds > 0 && args.taxRate! > 0)
    accountNumbers.push(taxOutputAccount(db, chart, args.taxRate!));
  if (accountNumbers.some((account) => !accountExists(db, chart, account)))
    throw new Error("DISPOSAL_ACCOUNT_NOT_IN_CHART");
  if (existingJournalId && existingDisposalMovement)
    return {
      asset: mapAsset(db, getAssetRow(db, tenantId, row.id), scope),
      residualBookValue: Number(existingDisposalMovement.amount),
      gainLoss: Number(
        existingDisposalMovement.gain_loss ??
          amount(Number(existingDisposalMovement.proceeds ?? args.proceeds) - Number(existingDisposalMovement.amount)),
      ),
      journalEntryId: existingJournalId,
    };
  const gross = amount(args.proceeds * (1 + (args.taxRate ?? 0) / 100));
  const vat = amount(gross - args.proceeds);
  const lines: BookingDraftEntity["lines"] = [];
  if (args.proceeds > 0)
    lines.push({
      id: `${row.id}-proceeds`,
      accountNumber: proceedsAccount!,
      debitAmount: gross,
      creditAmount: 0,
      memo: args.reason,
    });
  if (gainLoss < 0)
    lines.push({
      id: `${row.id}-loss`,
      accountNumber: accounts.loss,
      debitAmount: amount(-gainLoss),
      creditAmount: 0,
      memo: args.reason,
    });
  if (gainLoss > 0)
    lines.push({
      id: `${row.id}-gain`,
      accountNumber: accounts.gain,
      debitAmount: 0,
      creditAmount: gainLoss,
      taxCaseKey: 'DE_ZERO_EXEMPT',
      evidenceType: 'asset_disposal',
      evidenceReference: row.asset_number,
      memo: args.reason,
    });
  if (residualBookValue > 0)
    lines.push({
      id: `${row.id}-residual`,
      accountNumber: row.asset_account_number,
      debitAmount: 0,
      creditAmount: residualBookValue,
      memo: args.reason,
    });
  if (args.proceeds > 0 && vat > 0)
    lines.push({
      id: `${row.id}-vat`,
      accountNumber:
        taxOutputAccount(db, chart, args.taxRate!),
      debitAmount: 0,
      creditAmount: vat,
      taxCaseKey: (args.taxRate === 7 ? "DE_STD_7" : "DE_STD_19") as TaxCaseKey,
      taxRate: args.taxRate,
      netAmount: args.proceeds,
      taxAmount: vat,
      grossAmount: gross,
      memo: `USt ${args.taxRate}%`,
    });
  const scheduleBefore = getDepreciationSchedule(db, row.id, scope);
  let journalEntryId = "";
  const now = new Date().toISOString();
  db.transaction(() => {
    journalEntryId = postAssetJournal(db, scope, {
      draftId: `asset-disposal:${row.id}`,
      sourceType: "asset_disposal",
      sourceKey,
      postingDate: args.disposalDate,
      bookingText: `${args.proceeds > 0 ? "Anlagenverkauf" : "Anlagenabgang"} ${row.asset_number}`,
      reference: row.asset_number,
      tenantId,
      lines,
      options: args,
      inTransaction: true,
    });
    const drizzle = createDrizzle(db);
    drizzle
      .insert(schema.assetMovements)
      .values({
        id: randomUUID(),
        tenantId,
        assetId: row.id,
        type: "disposal",
        movementDate: args.disposalDate,
        amount: residualBookValue,
        proceeds: args.proceeds,
        gainLoss,
        journalEntryId,
        sourceType: "asset_disposal",
        sourceKey,
        reason: args.overrideReason?.trim() || args.reason,
        createdAt: now,
      })
      .run();
    drizzle
      .update(schema.assets)
      .set({
        status: args.proceeds > 0 ? "verkauft" : "stillgelegt",
        disposalDate: args.disposalDate,
        disposalProceeds: args.proceeds,
        updatedAt: now,
      })
      .where(
        and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, row.id)),
      )
      .run();
    drizzle
      .update(schema.assetDepreciationSchedule)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(schema.assetDepreciationSchedule.tenantId, tenantId),
          eq(schema.assetDepreciationSchedule.assetId, row.id),
          eq(schema.assetDepreciationSchedule.status, "planned"),
        ),
      )
      .run();
    const scheduleAfter = getDepreciationSchedule(db, row.id, scope);
    appendAuditLog(db, {
      entityType: "asset",
      entityId: row.id,
      action: "dispose",
      reason: args.overrideReason?.trim() || args.reason,
      before: assetSnapshot(row),
      after: {
        ...assetSnapshot({
          ...row,
          status: args.proceeds > 0 ? "verkauft" : "stillgelegt",
          disposal_date: args.disposalDate,
          disposal_proceeds: args.proceeds,
        }),
        residualBookValue,
        gainLoss,
        journalEntryId,
        scheduleBefore: auditSchedule(scheduleBefore),
        scheduleAfter: auditSchedule(scheduleAfter),
      },
      actor: "pro",
    });
  })();
  return {
    asset: mapAsset(db, getAssetRow(db, tenantId, row.id), scope),
    residualBookValue,
    gainLoss,
    journalEntryId,
  };
};
