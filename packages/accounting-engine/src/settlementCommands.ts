import {
  calculateBadDebtWriteOff,
  calculateInvoiceSettlement,
  calculateSkontoVatApportionment,
  CorrectionSettlementError,
  type BadDebtWriteOffInput,
  type InvoiceSettlementInput,
  type JournalCommand,
  type JournalLine,
  type SkontoVatApportionmentInput,
} from '@billme/accounting-shared';

export type SettlementCommandKind = 'skonto' | 'bad_debt' | 'advance_settlement';

export interface SettlementJournalAccounts {
  accountsReceivable: string;
  accountsPayable: string;
  revenue: string;
  expense: string;
  /** Explicit expense account supplied by the settlement domain facts. */
  badDebtExpenseAccount?: string;
  /** Explicit clearing account for an outgoing invoice advance. */
  advanceClearingReceivable?: string;
  /** Explicit clearing account for an incoming invoice advance. */
  advanceClearingPayable?: string;
  outputVat: string;
  inputVat: string;
}

export interface SettlementJournalSource {
  sourceId: string;
  sourceRevision: string;
  effectiveDate: string;
  postingDate: string;
  period: string;
  fiscalYear: number;
  currency: string;
  reference?: string;
}

export interface SettlementJournalBuildInput {
  kind: SettlementCommandKind;
  facts: Record<string, unknown>;
  source: SettlementJournalSource;
  accounts: SettlementJournalAccounts;
}

export interface SettlementJournalBuildResult {
  result: ReturnType<typeof calculateSkontoVatApportionment> | ReturnType<typeof calculateBadDebtWriteOff> | ReturnType<typeof calculateInvoiceSettlement>;
  command: JournalCommand;
}

const cents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const euros = (value: number): number => cents(value) / 100;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const documentType = (facts: Record<string, unknown>): 'outgoing_invoice' | 'incoming_invoice' => facts.documentType === 'incoming_invoice' || facts.direction === 'input' ? 'incoming_invoice' : 'outgoing_invoice';

const validateSettlementAmounts = (kind: SettlementCommandKind, facts: Record<string, unknown>): void => {
  const assertAmount = (value: unknown, field: string): void => {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new CorrectionSettlementError('INVALID_AMOUNT', `${field} must be a non-negative finite amount`);
    }
  };
  if (kind === 'skonto') assertAmount(facts.skontoAmount, 'skontoAmount');
  if (kind === 'bad_debt') assertAmount(facts.writeOffGrossAmount, 'writeOffGrossAmount');
  if (kind === 'advance_settlement') {
    const finalInvoice = facts.finalInvoice && typeof facts.finalInvoice === 'object' ? facts.finalInvoice as Record<string, unknown> : undefined;
    assertAmount(finalInvoice?.grossAmount, 'finalInvoice.grossAmount');
    for (const [collection, value] of [['advances', facts.advances], ['partialInvoices', facts.partialInvoices] as const]) {
      if (!Array.isArray(value)) continue;
      value.forEach((item, index) => {
        if (item && typeof item === 'object') assertAmount((item as Record<string, unknown>).grossAmount, `${collection}[${index}].grossAmount`);
      });
    }
  }
};

const taxCaseForRate = (rate: number): 'DE_STD_19' | 'DE_STD_7' | 'DE_ZERO_EXEMPT' => {
  if (rate === 19) return 'DE_STD_19';
  if (rate === 7) return 'DE_STD_7';
  if (rate === 0) return 'DE_ZERO_EXEMPT';
  throw new CorrectionSettlementError('INVALID_FACTS', `Unsupported settlement VAT rate ${rate}`);
};

const evidenceReferenceFor = (kind: SettlementCommandKind, facts: Record<string, unknown>, source: SettlementJournalSource): string => {
  const nested = facts.facts && typeof facts.facts === 'object' ? facts.facts as Record<string, unknown> : undefined;
  if (text(nested?.evidenceReference)) return text(nested?.evidenceReference)!;
  if (text(facts.evidenceReference)) return text(facts.evidenceReference)!;
  if (kind === 'bad_debt' && text(nested?.originalDocumentId)) return text(nested?.originalDocumentId)!;
  if (kind === 'advance_settlement') {
    const finalInvoice = facts.finalInvoice && typeof facts.finalInvoice === 'object' ? facts.finalInvoice as Record<string, unknown> : undefined;
    const ids = [finalInvoice?.id, ...(Array.isArray(facts.advances) ? facts.advances : []).map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined), ...(Array.isArray(facts.partialInvoices) ? facts.partialInvoices : []).map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined)].map(text).filter(Boolean);
    if (ids.length) return ids.join(',');
  }
  return source.reference ?? source.sourceId;
};

const settlementLines = (
  kind: SettlementCommandKind,
  facts: Record<string, unknown>,
  source: SettlementJournalSource,
  accounts: SettlementJournalAccounts,
  byRate: ReadonlyArray<{ rate: number; netAmount: number; taxAmount: number; grossAmount: number }>,
): JournalLine[] => {
  const incoming = documentType(facts) === 'incoming_invoice';
  const evidenceType = kind === 'bad_debt' ? 'ustg17_bad_debt' : kind;
  const evidenceReference = evidenceReferenceFor(kind, facts, source);
  const lines: JournalLine[] = [];
  if (kind === 'bad_debt' && !text(accounts.badDebtExpenseAccount)) {
    throw new CorrectionSettlementError('INVALID_FACTS', 'bad_debt requires an explicit bad-debt expense account');
  }
  const advanceClearing = incoming ? accounts.advanceClearingPayable : accounts.advanceClearingReceivable;
  if (kind === 'advance_settlement' && !text(advanceClearing)) {
    throw new CorrectionSettlementError(
      'INVALID_FACTS',
      `advance_settlement requires an explicit ${incoming ? 'advanceClearingPayable' : 'advanceClearingReceivable'} account`,
    );
  }
  for (const [index, allocation] of byRate.entries()) {
    const net = euros(allocation.netAmount);
    const tax = euros(allocation.taxAmount);
    const gross = euros(allocation.grossAmount);
    if (gross <= 0) continue;
    const taxCaseKey = taxCaseForRate(allocation.rate);
    const base = {
      taxCaseKey,
      taxRate: allocation.rate,
      netAmount: net,
      taxAmount: tax,
      grossAmount: gross,
      evidenceType,
      evidenceReference,
      memo: `${kind} ${taxCaseKey}`,
    } satisfies Partial<JournalLine>;
    if (kind === 'advance_settlement') {
      // Applying an advance only clears the advance balance against the
      // document open item. It must not recreate revenue or VAT from the
      // final invoice.
      if (incoming) {
        lines.push({ id: `${kind}:payable:${index + 1}`, accountNumber: accounts.accountsPayable, debitAmount: gross, creditAmount: 0, evidenceType: 'opos', evidenceReference, memo: `${kind} payable` });
        lines.push({ id: `${kind}:clearing:${index + 1}`, accountNumber: advanceClearing!, debitAmount: 0, creditAmount: gross, evidenceType: 'opos', evidenceReference, memo: `${kind} advance clearing` });
      } else {
        lines.push({ id: `${kind}:clearing:${index + 1}`, accountNumber: advanceClearing!, debitAmount: gross, creditAmount: 0, evidenceType: 'opos', evidenceReference, memo: `${kind} advance clearing` });
        lines.push({ id: `${kind}:receivable:${index + 1}`, accountNumber: accounts.accountsReceivable, debitAmount: 0, creditAmount: gross, evidenceType: 'opos', evidenceReference, memo: `${kind} receivable` });
      }
    } else if (incoming) {
      lines.push({ id: `${kind}:base:${index + 1}`, accountNumber: accounts.expense, debitAmount: 0, creditAmount: net, ...base });
      // VAT control lines intentionally carry no economic tax metadata.
      if (tax > 0) lines.push({ id: `${kind}:tax:${index + 1}`, accountNumber: accounts.inputVat, debitAmount: 0, creditAmount: tax, memo: `${kind} VAT ${taxCaseKey}` });
      lines.push({ id: `${kind}:payable:${index + 1}`, accountNumber: accounts.accountsPayable, debitAmount: gross, creditAmount: 0, evidenceType: 'opos', evidenceReference, memo: `${kind} payable` });
    } else {
      lines.push({ id: `${kind}:base:${index + 1}`, accountNumber: kind === 'bad_debt' ? accounts.badDebtExpenseAccount! : accounts.revenue, debitAmount: net, creditAmount: 0, ...base });
      // VAT control lines intentionally carry no economic tax metadata.
      if (tax > 0) lines.push({ id: `${kind}:tax:${index + 1}`, accountNumber: accounts.outputVat, debitAmount: tax, creditAmount: 0, memo: `${kind} VAT ${taxCaseKey}` });
      lines.push({ id: `${kind}:receivable:${index + 1}`, accountNumber: accounts.accountsReceivable, debitAmount: 0, creditAmount: gross, evidenceType: 'opos', evidenceReference, memo: `${kind} receivable` });
    }
  }
  if (!lines.length) throw new CorrectionSettlementError('INVALID_AMOUNT', `${kind} must produce a positive journal amount`);
  const debit = lines.reduce((sum, line) => sum + cents(line.debitAmount), 0);
  const credit = lines.reduce((sum, line) => sum + cents(line.creditAmount), 0);
  if (debit !== credit) throw new CorrectionSettlementError('INVALID_AMOUNT', `${kind} journal is not balanced`);
  return lines;
};

export const buildSettlementJournalCommand = (input: SettlementJournalBuildInput): SettlementJournalBuildResult => {
  validateSettlementAmounts(input.kind, input.facts);
  let result: SettlementJournalBuildResult['result'];
  let byRate: ReadonlyArray<{ rate: number; netAmount: number; taxAmount: number; grossAmount: number }>;
  if (input.kind === 'skonto') {
    result = calculateSkontoVatApportionment(input.facts as unknown as SkontoVatApportionmentInput);
    byRate = result.byRate;
  } else if (input.kind === 'bad_debt') {
    result = calculateBadDebtWriteOff(input.facts as unknown as BadDebtWriteOffInput);
    byRate = result.byRate;
  } else {
    const settlement = calculateInvoiceSettlement(input.facts as unknown as InvoiceSettlementInput);
    result = settlement;
    const finalInvoice = input.facts.finalInvoice as { taxBreakdown?: ReadonlyArray<{ rate: number; netAmount: number; taxAmount: number; grossAmount?: number }> } | undefined;
    // The settlement entry represents the amounts already covered by
    // advances/partials, not the remaining invoice due. The final invoice
    // itself owns its revenue and VAT posting.
    byRate = (finalInvoice?.taxBreakdown ?? []).map((entry, index) => {
      const due = settlement.dueByRate[index];
      const grossAmount = (cents(entry.grossAmount ?? entry.netAmount + entry.taxAmount) - cents(due?.grossAmount ?? 0)) / 100;
      const netAmount = (cents(entry.netAmount) - cents(due?.netAmount ?? 0)) / 100;
      const taxAmount = (cents(entry.taxAmount) - cents(due?.taxAmount ?? 0)) / 100;
      return { rate: entry.rate, grossAmount, netAmount, taxAmount };
    });
  }
  const lines = settlementLines(input.kind, input.facts, input.source, input.accounts, byRate);
  const commandId = `journal-command:${input.kind}:${input.source.sourceId}:${input.source.sourceRevision}`;
  const entry: JournalCommand['entry'] = {
    id: commandId,
    postingDate: input.source.postingDate,
    documentDate: input.source.effectiveDate,
    bookingText: input.kind === 'bad_debt' ? 'Forderungsausfall nach §17 UStG' : input.kind === 'skonto' ? 'Skonto' : 'Vorauszahlung / Verrechnung',
    reference: input.source.reference ?? evidenceReferenceFor(input.kind, input.facts, input.source),
    period: input.source.period,
    fiscalYear: input.source.fiscalYear,
    status: 'posted',
    sourceType: 'standalone_source',
    sourceKey: `settlement:${input.kind}:${input.source.sourceId}:${input.source.sourceRevision}`,
    lines: lines.map((line) => ({ ...line, id: `${commandId}:${line.id}` })),
  };
  return {
    result,
    command: {
      commandId,
      idempotencyKey: `standalone_source:${input.source.sourceId}:${input.source.sourceRevision}`,
      immutableRevision: input.source.sourceRevision,
      effectiveDate: input.source.effectiveDate,
      currency: input.source.currency,
      source: { sourceType: 'standalone_source', sourceId: input.source.sourceId, sourceRevision: input.source.sourceRevision },
      entry,
    },
  };
};
