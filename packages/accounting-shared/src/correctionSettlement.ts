/**
 * Pure calculations for immutable invoice corrections and settlement events.
 * Amounts are EUR and are returned at cent precision.
 */

export interface TaxBreakdownEntry {
  rate: number;
  netAmount: number;
  taxAmount: number;
  grossAmount?: number;
}

export interface SkontoVatApportionmentInput {
  taxBreakdown: readonly TaxBreakdownEntry[];
  skontoAmount?: number;
  skontoPercent?: number;
}

export interface SkontoVatApportionmentLine {
  rate: number;
  grossAmount: number;
  netAmount: number;
  taxAmount: number;
}

export interface SkontoVatApportionment {
  discountGrossAmount: number;
  discountNetAmount: number;
  discountTaxAmount: number;
  byRate: readonly SkontoVatApportionmentLine[];
}

export type CorrectionSettlementErrorCode =
  | 'INVALID_FACTS'
  | 'INVALID_AMOUNT'
  | 'REFERENCE_REQUIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ORIGINAL_CHANGED'
  | 'TAX_EFFECTIVE_DATE_INVALID'
  | 'OVER_CREDIT';

export class CorrectionSettlementError extends Error {
  constructor(public readonly code: CorrectionSettlementErrorCode, message: string) {
    super(message);
    this.name = 'CorrectionSettlementError';
  }
}

export interface ImmutableOriginalDocument {
  documentId: string;
  documentNumber: string;
  revision: string;
  snapshotHash: string;
  taxEffectiveDate: string;
  taxBreakdown: readonly TaxBreakdownEntry[];
  /** Optional live hash supplied by an adapter to prove the original was not edited. */
  currentSnapshotHash?: string;
}

export interface CorrectionDeltaInput {
  rate: number;
  grossAmount: number;
}

export interface CorrectionDelta {
  rate: number;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}

export interface LinkedCorrectionDocument {
  id: string;
  idempotencyKey: string;
  correctionDate: string;
  taxEffectiveDate: string;
  originalDocumentId: string;
  originalDocumentNumber: string;
  originalRevision: string;
  originalSnapshotHash: string;
  deltas: readonly CorrectionDelta[];
  /** Signed accounting delta: a credit reduces the original document. */
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  creditNetAmount: number;
  creditTaxAmount: number;
  creditGrossAmount: number;
  fingerprint: string;
}

export interface LinkedCorrectionInput {
  id: string;
  idempotencyKey: string;
  correctionDate: string;
  taxEffectiveDate?: string;
  original: ImmutableOriginalDocument;
  deltas: readonly CorrectionDeltaInput[];
  existing?: readonly LinkedCorrectionDocument[];
}

export interface LinkedCorrectionResult {
  document: LinkedCorrectionDocument;
  replayed: boolean;
}

const roundCents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const fromCents = (value: number): number => value / 100;
const finiteCents = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return roundCents(value);
};

const requireNonEmpty = (value: string | undefined, code: CorrectionSettlementErrorCode, label: string): string => {
  if (!value?.trim()) throw new CorrectionSettlementError(code, `${label} is required`);
  return value.trim();
};

const parseIsoDate = (value: string, code: CorrectionSettlementErrorCode, label: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CorrectionSettlementError(code, `${label} is invalid`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new CorrectionSettlementError(code, `${label} is invalid`);
  }
  return value;
};

const validateTaxBreakdown = (taxBreakdown: readonly TaxBreakdownEntry[]): Array<TaxBreakdownEntry & { grossCents: number }> => {
  if (taxBreakdown.length === 0) throw new Error('taxBreakdown must not be empty');
  return taxBreakdown.map((entry) => {
    if (!Number.isFinite(entry.rate) || entry.rate < 0 || entry.rate >= 100) throw new Error('VAT rate is invalid');
    const netCents = finiteCents(entry.netAmount, 'netAmount');
    const taxCents = finiteCents(entry.taxAmount, 'taxAmount');
    if (netCents < 0 || taxCents < 0) throw new Error('tax amounts must not be negative');
    const expectedTaxCents = Math.round(netCents * entry.rate / 100);
    if (Math.abs(taxCents - expectedTaxCents) > 1) throw new Error('taxAmount does not match VAT rate');
    const grossCents = entry.grossAmount === undefined
      ? netCents + taxCents
      : finiteCents(entry.grossAmount, 'grossAmount');
    if (grossCents < 0 || grossCents !== netCents + taxCents) throw new Error('grossAmount must equal netAmount plus taxAmount');
    return { ...entry, grossCents };
  });
};

const calculateSkontoVatApportionmentInternal = (
  input: SkontoVatApportionmentInput,
): SkontoVatApportionment => {
  const source = validateTaxBreakdown(input.taxBreakdown);
  const totalGrossCents = source.reduce((sum, entry) => sum + entry.grossCents, 0);
  const requestedCents = input.skontoAmount === undefined
    ? Math.round(totalGrossCents * (input.skontoPercent ?? 0) / 100)
    : finiteCents(input.skontoAmount, 'skontoAmount');
  if (input.skontoAmount === undefined && input.skontoPercent === undefined) throw new Error('skontoAmount or skontoPercent is required');
  if (input.skontoPercent !== undefined && (!Number.isFinite(input.skontoPercent) || input.skontoPercent < 0 || input.skontoPercent > 100)) throw new Error('skontoPercent is invalid');
  if (requestedCents < 0 || requestedCents > totalGrossCents) throw new Error('skontoAmount exceeds invoice gross amount');
  let allocated = 0;
  const byRate = source.map((entry, index) => {
    const grossCents = index === source.length - 1
      ? requestedCents - allocated
      : Math.round(requestedCents * entry.grossCents / totalGrossCents);
    allocated += grossCents;
    const netCents = entry.rate === 0 ? grossCents : Math.round(grossCents * 100 / (100 + entry.rate));
    return {
      rate: entry.rate,
      grossAmount: fromCents(grossCents),
      netAmount: fromCents(netCents),
      taxAmount: fromCents(grossCents - netCents),
    };
  });
  return {
    discountGrossAmount: fromCents(requestedCents),
    discountNetAmount: fromCents(byRate.reduce((sum, line) => sum + roundCents(line.netAmount), 0)),
    discountTaxAmount: fromCents(byRate.reduce((sum, line) => sum + roundCents(line.taxAmount), 0)),
    byRate,
  };
};

export const calculateSkontoVatApportionment = (
  input: SkontoVatApportionmentInput,
): SkontoVatApportionment => {
  try {
    return calculateSkontoVatApportionmentInternal(input);
  } catch (error) {
    if (error instanceof CorrectionSettlementError) throw error;
    const message = error instanceof Error ? error.message : 'skonto facts are invalid';
    throw new CorrectionSettlementError(
      /amount|percent|negative|finite|exceeds/.test(message) ? 'INVALID_AMOUNT' : 'INVALID_FACTS',
      message,
    );
  }
};

const correctionFingerprint = (input: {
  original: ImmutableOriginalDocument;
  correctionDate: string;
  taxEffectiveDate: string;
  deltas: readonly CorrectionDelta[];
}): string => JSON.stringify({
  originalDocumentId: input.original.documentId,
  originalRevision: input.original.revision,
  originalSnapshotHash: input.original.snapshotHash,
  correctionDate: input.correctionDate,
  taxEffectiveDate: input.taxEffectiveDate,
  deltas: input.deltas.map((delta) => ({
    rate: delta.rate,
    netAmount: delta.netAmount,
    taxAmount: delta.taxAmount,
    grossAmount: delta.grossAmount,
  })),
});

export const createLinkedCorrection = (input: LinkedCorrectionInput): LinkedCorrectionResult => {
  const id = requireNonEmpty(input.id, 'REFERENCE_REQUIRED', 'correction id');
  const idempotencyKey = requireNonEmpty(input.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey');
  const originalId = requireNonEmpty(input.original.documentId, 'REFERENCE_REQUIRED', 'original document id');
  const originalNumber = requireNonEmpty(input.original.documentNumber, 'REFERENCE_REQUIRED', 'original document number');
  const revision = requireNonEmpty(input.original.revision, 'ORIGINAL_CHANGED', 'original revision');
  const snapshotHash = requireNonEmpty(input.original.snapshotHash, 'ORIGINAL_CHANGED', 'original snapshot hash');
  const correctionDate = parseIsoDate(input.correctionDate, 'INVALID_FACTS', 'correctionDate');
  const originalTaxDate = parseIsoDate(input.original.taxEffectiveDate, 'TAX_EFFECTIVE_DATE_INVALID', 'original tax effective date');
  const taxEffectiveDate = parseIsoDate(input.taxEffectiveDate ?? originalTaxDate, 'TAX_EFFECTIVE_DATE_INVALID', 'tax effective date');
  if (correctionDate < originalTaxDate || taxEffectiveDate < originalTaxDate) {
    throw new CorrectionSettlementError('TAX_EFFECTIVE_DATE_INVALID', 'tax effective date must not precede the original tax effective date');
  }
  if (input.original.currentSnapshotHash !== undefined && input.original.currentSnapshotHash !== snapshotHash) {
    throw new CorrectionSettlementError('ORIGINAL_CHANGED', 'original document snapshot changed');
  }

  let source: Array<TaxBreakdownEntry & { grossCents: number }>;
  try {
    source = validateTaxBreakdown(input.original.taxBreakdown);
  } catch (error) {
    throw new CorrectionSettlementError('INVALID_FACTS', error instanceof Error ? error.message : 'original tax facts are invalid');
  }
  if (input.deltas.length === 0) throw new CorrectionSettlementError('INVALID_AMOUNT', 'at least one correction delta is required');

  const sourceByRate = new Map<number, number>();
  for (const entry of source) sourceByRate.set(entry.rate, (sourceByRate.get(entry.rate) ?? 0) + entry.grossCents);
  const requestedByRate = new Map<number, number>();
  for (const inputDelta of input.deltas) {
    if (!Number.isFinite(inputDelta.rate) || !sourceByRate.has(inputDelta.rate)) {
      throw new CorrectionSettlementError('INVALID_FACTS', `VAT rate ${inputDelta.rate} is not present on the original document`);
    }
    let grossCents: number;
    try {
      grossCents = finiteCents(inputDelta.grossAmount, 'correction gross amount');
    } catch (error) {
      throw new CorrectionSettlementError('INVALID_AMOUNT', error instanceof Error ? error.message : 'correction gross amount is invalid');
    }
    if (grossCents <= 0) throw new CorrectionSettlementError('INVALID_AMOUNT', 'correction amount must be positive');
    requestedByRate.set(inputDelta.rate, (requestedByRate.get(inputDelta.rate) ?? 0) + grossCents);
  }

  const existing = input.existing ?? [];
  const fingerprintDeltas = [...requestedByRate.entries()].map(([rate, grossCents]) => {
    const netCents = rate === 0 ? grossCents : Math.round(grossCents * 100 / (100 + rate));
    return {
      rate,
      grossAmount: fromCents(-grossCents),
      netAmount: fromCents(-netCents),
      taxAmount: fromCents(-(grossCents - netCents)),
    };
  }).sort((a, b) => a.rate - b.rate);
  const fingerprint = correctionFingerprint({ original: input.original, correctionDate, taxEffectiveDate, deltas: fingerprintDeltas });
  const sameKey = existing.find((document) => document.idempotencyKey === idempotencyKey);
  if (sameKey) {
    if (sameKey.fingerprint !== fingerprint) {
      throw new CorrectionSettlementError('IDEMPOTENCY_CONFLICT', 'idempotency key belongs to another correction');
    }
    return { document: sameKey, replayed: true };
  }

  const creditedByRate = new Map<number, number>();
  for (const document of existing) {
    if (document.originalDocumentId !== originalId) continue;
    if (document.originalSnapshotHash !== snapshotHash || document.originalRevision !== revision) {
      throw new CorrectionSettlementError('ORIGINAL_CHANGED', 'existing correction references a changed original document');
    }
    for (const delta of document.deltas) {
      creditedByRate.set(delta.rate, (creditedByRate.get(delta.rate) ?? 0) + Math.abs(roundCents(delta.grossAmount)));
    }
  }
  for (const [rate, requestedCents] of requestedByRate) {
    const available = sourceByRate.get(rate)! - (creditedByRate.get(rate) ?? 0);
    if (requestedCents > available) {
      throw new CorrectionSettlementError('OVER_CREDIT', `correction exceeds remaining amount for VAT rate ${rate}`);
    }
  }

  const deltas = fingerprintDeltas;
  const creditNetCents = deltas.reduce((sum, delta) => sum + Math.abs(roundCents(delta.netAmount)), 0);
  const creditTaxCents = deltas.reduce((sum, delta) => sum + Math.abs(roundCents(delta.taxAmount)), 0);
  const creditGrossCents = deltas.reduce((sum, delta) => sum + Math.abs(roundCents(delta.grossAmount)), 0);
  const document: LinkedCorrectionDocument = {
    id,
    idempotencyKey,
    correctionDate,
    taxEffectiveDate,
    originalDocumentId: originalId,
    originalDocumentNumber: originalNumber,
    originalRevision: revision,
    originalSnapshotHash: snapshotHash,
    deltas,
    netAmount: fromCents(-creditNetCents),
    taxAmount: fromCents(-creditTaxCents),
    grossAmount: fromCents(-creditGrossCents),
    creditNetAmount: fromCents(creditNetCents),
    creditTaxAmount: fromCents(creditTaxCents),
    creditGrossAmount: fromCents(creditGrossCents),
    fingerprint,
  };
  return { document, replayed: false };
};

export type Ustg17AdjustmentReason = 'bad_debt' | 'price_reduction' | 'cancellation' | 'other';

export interface Ustg17AdjustmentFactsInput {
  legalBasis: string;
  reason: Ustg17AdjustmentReason;
  originalDocumentId: string;
  originalDocumentNumber: string;
  originalTaxEffectiveDate: string;
  adjustmentDate: string;
  evidenceReference: string;
}

export interface Ustg17AdjustmentFacts {
  legalBasis: '§17 UStG';
  reason: Ustg17AdjustmentReason;
  originalDocumentId: string;
  originalDocumentNumber: string;
  originalTaxEffectiveDate: string;
  adjustmentDate: string;
  /** The correction becomes tax-effective on the adjustment date. */
  taxEffectiveDate: string;
  evidenceReference: string;
}

export const validateUstg17AdjustmentFacts = (
  input: Ustg17AdjustmentFactsInput,
): Ustg17AdjustmentFacts => {
  if (input.legalBasis !== '§17 UStG') {
    throw new CorrectionSettlementError('INVALID_FACTS', 'UStG §17 is required as legal basis');
  }
  if (!['bad_debt', 'price_reduction', 'cancellation', 'other'].includes(input.reason)) {
    throw new CorrectionSettlementError('INVALID_FACTS', 'UStG §17 adjustment reason is invalid');
  }
  const originalDocumentId = requireNonEmpty(input.originalDocumentId, 'INVALID_FACTS', 'original document id');
  const originalDocumentNumber = requireNonEmpty(input.originalDocumentNumber, 'INVALID_FACTS', 'original document number');
  const evidenceReference = requireNonEmpty(input.evidenceReference, 'INVALID_FACTS', 'evidence reference');
  const originalTaxEffectiveDate = parseIsoDate(input.originalTaxEffectiveDate, 'INVALID_FACTS', 'original tax effective date');
  const adjustmentDate = parseIsoDate(input.adjustmentDate, 'INVALID_FACTS', 'adjustment date');
  if (adjustmentDate < originalTaxEffectiveDate) {
    throw new CorrectionSettlementError('INVALID_FACTS', 'adjustment date must not precede the original tax effective date');
  }
  return {
    legalBasis: '§17 UStG',
    reason: input.reason,
    originalDocumentId,
    originalDocumentNumber,
    originalTaxEffectiveDate,
    adjustmentDate,
    taxEffectiveDate: adjustmentDate,
    evidenceReference,
  };
};

export interface BadDebtWriteOffInput {
  taxBreakdown: readonly TaxBreakdownEntry[];
  writeOffGrossAmount: number;
  facts: Ustg17AdjustmentFactsInput;
}

export interface BadDebtWriteOffResult {
  writeOffGrossAmount: number;
  writeOffNetAmount: number;
  writeOffTaxAmount: number;
  byRate: readonly SkontoVatApportionmentLine[];
  facts: Ustg17AdjustmentFacts;
}

export const calculateBadDebtWriteOff = (input: BadDebtWriteOffInput): BadDebtWriteOffResult => {
  const facts = validateUstg17AdjustmentFacts(input.facts);
  if (facts.reason !== 'bad_debt') {
    throw new CorrectionSettlementError('INVALID_FACTS', 'bad-debt write-off requires a bad_debt §17 reason');
  }
  let allocation: SkontoVatApportionment;
  try {
    allocation = calculateSkontoVatApportionment({
      taxBreakdown: input.taxBreakdown,
      skontoAmount: input.writeOffGrossAmount,
    });
  } catch (error) {
    throw new CorrectionSettlementError('INVALID_AMOUNT', error instanceof Error ? error.message : 'write-off amount is invalid');
  }
  return {
    writeOffGrossAmount: allocation.discountGrossAmount,
    writeOffNetAmount: allocation.discountNetAmount,
    writeOffTaxAmount: allocation.discountTaxAmount,
    byRate: allocation.byRate,
    facts,
  };
};

export interface SettlementDocumentInput {
  id: string;
  kind: 'advance' | 'partial';
  grossAmount?: number;
  taxBreakdown?: readonly TaxBreakdownEntry[];
}

export interface InvoiceSettlementInput {
  finalInvoice: {
    id?: string;
    grossAmount?: number;
    taxBreakdown: readonly TaxBreakdownEntry[];
  };
  advances?: readonly SettlementDocumentInput[];
  partialInvoices?: readonly SettlementDocumentInput[];
}

export interface InvoiceSettlementResult {
  finalGrossAmount: number;
  settledGrossAmount: number;
  dueGrossAmount: number;
  dueNetAmount: number;
  dueTaxAmount: number;
  dueByRate: readonly SkontoVatApportionmentLine[];
  advanceGrossAmount: number;
  partialGrossAmount: number;
}

const settlementLinesFor = (
  document: SettlementDocumentInput,
  finalBreakdown: readonly (TaxBreakdownEntry & { grossCents: number })[],
): readonly SkontoVatApportionmentLine[] => {
  requireNonEmpty(document.id, 'REFERENCE_REQUIRED', 'settlement document id');
  if (document.taxBreakdown?.length) {
    let normalized: Array<TaxBreakdownEntry & { grossCents: number }>;
    try {
      normalized = validateTaxBreakdown(document.taxBreakdown);
    } catch (error) {
      throw new CorrectionSettlementError('INVALID_FACTS', error instanceof Error ? error.message : 'settlement tax facts are invalid');
    }
    const finalRates = new Set(finalBreakdown.map((entry) => entry.rate));
    if (normalized.some((entry) => !finalRates.has(entry.rate))) {
      throw new CorrectionSettlementError('INVALID_FACTS', 'settlement VAT rate is not present on the final invoice');
    }
    const grossCents = normalized.reduce((sum, entry) => sum + entry.grossCents, 0);
    if (document.grossAmount !== undefined) {
      let expectedGrossCents: number;
      try {
        expectedGrossCents = finiteCents(document.grossAmount, 'settlement gross amount');
      } catch (error) {
        throw new CorrectionSettlementError('INVALID_AMOUNT', error instanceof Error ? error.message : 'settlement gross amount is invalid');
      }
      if (expectedGrossCents !== grossCents) throw new CorrectionSettlementError('INVALID_AMOUNT', 'settlement gross amount does not match tax breakdown');
    }
    return normalized.map((entry) => ({
      rate: entry.rate,
      grossAmount: fromCents(entry.grossCents),
      netAmount: fromCents(entry.grossCents - roundCents(entry.taxAmount)),
      taxAmount: fromCents(roundCents(entry.taxAmount)),
    }));
  }
  if (document.grossAmount === undefined) throw new CorrectionSettlementError('INVALID_AMOUNT', 'settlement gross amount is required');
  try {
    return calculateSkontoVatApportionment({ taxBreakdown: finalBreakdown, skontoAmount: document.grossAmount }).byRate;
  } catch (error) {
    if (error instanceof CorrectionSettlementError && /exceeds/.test(error.message)) {
      throw new CorrectionSettlementError('OVER_CREDIT', error.message);
    }
    if (error instanceof CorrectionSettlementError) throw error;
    throw new CorrectionSettlementError('INVALID_AMOUNT', error instanceof Error ? error.message : 'settlement amount is invalid');
  }
};

export const calculateInvoiceSettlement = (input: InvoiceSettlementInput): InvoiceSettlementResult => {
  let finalBreakdown: Array<TaxBreakdownEntry & { grossCents: number }>;
  try {
    finalBreakdown = validateTaxBreakdown(input.finalInvoice.taxBreakdown);
  } catch (error) {
    throw new CorrectionSettlementError('INVALID_FACTS', error instanceof Error ? error.message : 'final invoice tax facts are invalid');
  }
  const finalGrossCents = finalBreakdown.reduce((sum, entry) => sum + entry.grossCents, 0);
  if (input.finalInvoice.grossAmount !== undefined) {
    let expectedGrossCents: number;
    try {
      expectedGrossCents = finiteCents(input.finalInvoice.grossAmount, 'final invoice gross amount');
    } catch (error) {
      throw new CorrectionSettlementError('INVALID_AMOUNT', error instanceof Error ? error.message : 'final invoice gross amount is invalid');
    }
    if (expectedGrossCents !== finalGrossCents) throw new CorrectionSettlementError('INVALID_AMOUNT', 'final invoice gross amount does not match tax breakdown');
  }
  const credits = [...(input.advances ?? []), ...(input.partialInvoices ?? [])];
  const finalInvoiceId = typeof input.finalInvoice.id === 'string' && input.finalInvoice.id.trim() ? input.finalInvoice.id.trim() : undefined;
  const documentIds = new Set<string>();
  for (const document of credits) {
    const documentId = requireNonEmpty(document.id, 'REFERENCE_REQUIRED', 'settlement document id');
    if (documentId === finalInvoiceId || documentIds.has(documentId)) {
      throw new CorrectionSettlementError('IDEMPOTENCY_CONFLICT', `settlement document id ${documentId} is duplicated`);
    }
    documentIds.add(documentId);
  }
  const finalByRate = new Map<number, number>(finalBreakdown.map((entry) => [entry.rate, entry.grossCents]));
  const settledByRate = new Map<number, { netCents: number; taxCents: number; grossCents: number }>();
  let advanceGrossCents = 0;
  let partialGrossCents = 0;
  for (const document of credits) {
    const lines = settlementLinesFor(document, finalBreakdown);
    for (const line of lines) {
      const grossCents = roundCents(line.grossAmount);
      const netCents = roundCents(line.netAmount);
      const taxCents = roundCents(line.taxAmount);
      const current = settledByRate.get(line.rate) ?? { netCents: 0, taxCents: 0, grossCents: 0 };
      current.netCents += netCents;
      current.taxCents += taxCents;
      current.grossCents += grossCents;
      settledByRate.set(line.rate, current);
    }
    const documentGrossCents = lines.reduce((sum, line) => sum + roundCents(line.grossAmount), 0);
    if (document.kind === 'advance') advanceGrossCents += documentGrossCents;
    else partialGrossCents += documentGrossCents;
  }
  const dueByRate = finalBreakdown.map((entry) => {
    const settled = settledByRate.get(entry.rate) ?? { netCents: 0, taxCents: 0, grossCents: 0 };
    if (settled.grossCents > (finalByRate.get(entry.rate) ?? 0)) {
      throw new CorrectionSettlementError('OVER_CREDIT', `settlement exceeds final invoice amount for VAT rate ${entry.rate}`);
    }
    const grossCents = entry.grossCents - settled.grossCents;
    const netCents = roundCents(entry.netAmount) - settled.netCents;
    const taxCents = roundCents(entry.taxAmount) - settled.taxCents;
    if (netCents < 0 || taxCents < 0) {
      throw new CorrectionSettlementError('OVER_CREDIT', `settlement exceeds final invoice tax amount for VAT rate ${entry.rate}`);
    }
    return {
      rate: entry.rate,
      grossAmount: fromCents(grossCents),
      netAmount: fromCents(netCents),
      taxAmount: fromCents(taxCents),
    };
  });
  const settledGrossCents = advanceGrossCents + partialGrossCents;
  return {
    finalGrossAmount: fromCents(finalGrossCents),
    settledGrossAmount: fromCents(settledGrossCents),
    dueGrossAmount: fromCents(finalGrossCents - settledGrossCents),
    dueNetAmount: fromCents(dueByRate.reduce((sum, line) => sum + roundCents(line.netAmount), 0)),
    dueTaxAmount: fromCents(dueByRate.reduce((sum, line) => sum + roundCents(line.taxAmount), 0)),
    dueByRate,
    advanceGrossAmount: fromCents(advanceGrossCents),
    partialGrossAmount: fromCents(partialGrossCents),
  };
};
