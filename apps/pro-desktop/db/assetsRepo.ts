import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { and, asc, eq } from "drizzle-orm";
import { createDrizzle, schema } from "@billme/desktop-data/drizzle";
import {
  buildDepreciationSchedule,
  computeAssetDisposal,
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

const mapAsset = (
  db: Database.Database,
  row: AssetRow,
  scope: TenantScope,
): AssetRecord => {
  const schedule = getDepreciationSchedule(db, row.id, scope);
  const posted = schedule
    .filter((period) => period.status === "posted")
    .reduce((sum, period) => sum + period.amount, 0);
  const disposal = row.disposal_date
    ? computeAssetDisposal({
        ...scheduleInput(row),
        disposalDate: row.disposal_date,
        proceeds: Number(row.disposal_proceeds ?? 0),
      })
    : null;
  const residualValue =
    disposal?.residualBookValue ??
    Math.max(0, amount(Number(row.acquisition_cost) - posted));
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
    sourceKey: `incoming_invoice:${invoiceId}`,
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
  saveDraft(db, draft, scope);
  const posted = postDraft(
    db,
    args.draftId,
    {
      postingDate: args.postingDate,
      idempotencyKey: args.sourceKey,
      sourceType: args.sourceType,
      softLockOverride: args.options.softLockOverride,
      overrideReason: args.options.overrideReason,
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
  const existingRow = existingId ? getAssetRow(db, tenantId, id) : undefined;
  if (input.status === "aktiv")
    assertPostingPeriod(db, tenantId, input.activationDate, input);
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
      } else if (input.sourceIncomingInvoiceId) {
        const linked = matchingPostedIncomingInvoice(
          db,
          tenantId,
          input.sourceIncomingInvoiceId,
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

    appendAuditLog(db, {
      entityType: "asset",
      entityId: id,
      action: existingRow ? "update" : "create",
      reason: input.overrideReason?.trim() || reason,
      before: existingRow ? assetSnapshot(existingRow) : null,
        after: assetSnapshot({
          ...input,
          id,
          acquisitionOffsetAccountNumber: acquisitionOffsetAccountNumber ?? undefined,
          sourceIncomingInvoiceId: sourceIncomingInvoiceId ?? undefined,
          activationJournalEntryId: activationJournalEntryId ?? undefined,
      }),
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
  requireIsoDate(args.postingDate, "posting");
  assertPostingPeriod(db, tenantId, args.postingDate, args);
  if (asset.status === "entwurf") throw new Error("ASSET_NOT_ACTIVE");
  const scheduleEntry = getDepreciationSchedule(db, asset.id, scope).find(
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
  const chart = activeChart(db, tenantId);
  const expenseAccount = DEPRECIATION_EXPENSE_ACCOUNTS[chart];
  if (
    !accountExists(db, chart, expenseAccount) ||
    !accountExists(db, chart, asset.asset_account_number)
  )
    throw new Error("DEPRECIATION_ACCOUNT_NOT_IN_CHART");
  const journalEntryId = postAssetJournal(db, scope, {
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
  });
  const postedAt = new Date().toISOString();
  db.transaction(() => {
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
      .run();
    appendAuditLog(db, {
      entityType: "asset",
      entityId: asset.id,
      action: "depreciation_posted",
      reason: args.overrideReason?.trim() || args.reason,
      before: null,
      after: {
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
  requireIsoDate(args.disposalDate, "disposal");
  assertPostingPeriod(db, tenantId, args.disposalDate, args);
  if (row.depreciation_method === "pool")
    throw new Error("POOL_INDIVIDUAL_DISPOSAL_NOT_SUPPORTED");
  if (row.disposal_date) throw new Error("ASSET_ALREADY_DISPOSED");
  if (args.proceeds > 0 && args.taxRate === undefined)
    throw new Error("TAX_RATE_REQUIRED_FOR_PROCEEDS");
  const result = computeAssetDisposal({
    ...scheduleInput(row),
    disposalDate: args.disposalDate,
    proceeds: args.proceeds,
  });
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
  const sourceKey = `asset_disposal:${row.id}`;
  const existingJournalId = sourceJournalId(
    db,
    tenantId,
    "asset_disposal",
    sourceKey,
  );
  if (existingJournalId)
    return {
      asset: mapAsset(db, getAssetRow(db, tenantId, row.id), scope),
      residualBookValue: result.residualBookValue,
      gainLoss: result.gainLoss,
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
  if (result.gainLoss < 0)
    lines.push({
      id: `${row.id}-loss`,
      accountNumber: accounts.loss,
      debitAmount: amount(-result.gainLoss),
      creditAmount: 0,
      memo: args.reason,
    });
  if (result.gainLoss > 0)
    lines.push({
      id: `${row.id}-gain`,
      accountNumber: accounts.gain,
      debitAmount: 0,
      creditAmount: result.gainLoss,
      taxCaseKey: 'DE_ZERO_EXEMPT',
      evidenceType: 'asset_disposal',
      evidenceReference: row.asset_number,
      memo: args.reason,
    });
  lines.push({
    id: `${row.id}-residual`,
    accountNumber: row.asset_account_number,
    debitAmount: 0,
    creditAmount: result.residualBookValue,
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
  const journalEntryId = postAssetJournal(db, scope, {
    draftId: `asset-disposal:${row.id}`,
    sourceType: "asset_disposal",
    sourceKey,
    postingDate: args.disposalDate,
    bookingText: `${args.proceeds > 0 ? "Anlagenverkauf" : "Anlagenabgang"} ${row.asset_number}`,
    reference: row.asset_number,
    tenantId,
    lines,
    options: args,
  });
  const now = new Date().toISOString();
  db.transaction(() => {
    const drizzle = createDrizzle(db);
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
    drizzle
      .insert(schema.assetMovements)
      .values({
        id: randomUUID(),
        tenantId,
        assetId: row.id,
        type: "disposal",
        movementDate: args.disposalDate,
        amount: result.residualBookValue,
        proceeds: args.proceeds,
        gainLoss: result.gainLoss,
        journalEntryId,
        sourceType: "asset_disposal",
        sourceKey,
        reason: args.overrideReason?.trim() || args.reason,
        createdAt: now,
      })
      .run();
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
        residualBookValue: result.residualBookValue,
        gainLoss: result.gainLoss,
        journalEntryId,
      },
      actor: "pro",
    });
  })();
  return {
    asset: mapAsset(db, getAssetRow(db, tenantId, row.id), scope),
    residualBookValue: result.residualBookValue,
    gainLoss: result.gainLoss,
    journalEntryId,
  };
};
