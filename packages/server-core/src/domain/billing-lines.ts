import { z } from 'zod';

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const finite = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const commonLineFields = {
  description: z.string().default(''),
  quantity: z.number().default(0),
  price: z.number().default(0),
  total: z.number().default(0),
  articleId: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  taxRate: z.number().min(0).optional(),
  note: z.string().optional(),
};

const itemLineSchema = z.object({ ...commonLineFields, kind: z.literal('item') });
const timeLineSchema = z.object({
  ...commonLineFields,
  kind: z.literal('time'),
  date: z.string().optional(),
  durationMinutes: z.number().nonnegative().optional(),
});
const optionalLineSchema = z.object({
  ...commonLineFields,
  kind: z.literal('optional'),
  optionNote: z.string().optional(),
});
const textLineSchema = z.object({
  ...commonLineFields,
  kind: z.literal('text'),
  quantity: z.number().default(0),
  price: z.number().default(0),
  total: z.number().default(0),
});
const groupLineSchema = z.object({
  ...commonLineFields,
  kind: z.literal('group'),
  quantity: z.number().default(0),
  price: z.number().default(0),
  total: z.number().default(0),
  groupId: z.string().optional(),
});
const summaryLineSchema = z.object({
  ...commonLineFields,
  kind: z.literal('summary'),
  quantity: z.number().default(0),
  price: z.number().default(0),
  total: z.number().default(0),
  summaryScope: z.enum(['running', 'group']).default('running'),
  summaryMetric: z.enum(['amount', 'quantity']).default('amount'),
  summaryUnit: z.string().optional(),
});

const typedBillingLineSchema = z.discriminatedUnion('kind', [
  itemLineSchema,
  timeLineSchema,
  optionalLineSchema,
  textLineSchema,
  groupLineSchema,
  summaryLineSchema,
]);

/**
 * Canonical persisted line schema. Older documents have no `kind`; those are
 * deliberately normalized to billable `item` lines at this seam.
 */
export const billingLineItemSchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !('kind' in value) ? { ...value, kind: 'item' } : value),
  typedBillingLineSchema,
);

export type BillingDocumentLine = z.infer<typeof typedBillingLineSchema>;
export type BillingLineKind = BillingDocumentLine['kind'];
export type BillingLineItem = BillingDocumentLine;
export type BillingLineInput = {
  kind?: BillingLineKind;
  description?: string;
  quantity?: number;
  price?: number;
  total?: number;
  unit?: string;
  discountPercent?: number;
  taxRate?: number;
};

export const billingLineKinds = ['item', 'time', 'optional', 'text', 'group', 'summary'] as const;

export const isBillableLine = (line: BillingLineInput): boolean =>
  line.kind === 'item' || line.kind === 'time' || line.kind === undefined;

export const isOptionalLine = (line: BillingLineInput): boolean =>
  line.kind === 'optional';

/** Derived amount; persisted `total` remains a legacy/cache compatibility field. */
export const getBillingLineAmount = (line: BillingLineInput): number => {
  if (line.kind && !isBillableLine(line)) return 0;
  const quantity = finite(line.quantity);
  const price = finite(line.price);
  const discount = Math.min(100, Math.max(0, finite(line.discountPercent)));
  if (line.quantity !== undefined && line.price !== undefined) return round2(quantity * price * (1 - discount / 100));
  return round2(finite(line.total));
};

export type BillingLineSummary = {
  line: BillingDocumentLine;
  amount: number;
  groupId?: string;
};

export type BillingDocumentSubtotal = {
  index: number;
  scope: 'running' | 'group';
  amount: number;
  quantities: Record<string, number>;
};

export type BillingDocumentResolution = {
  lines: BillingLineSummary[];
  billableLines: BillingLineSummary[];
  optionalLines: BillingLineSummary[];
  structuralLines: BillingDocumentLine[];
  netAmount: number;
  groups: Array<{ id: string; label: string; amount: number; quantities: Record<string, number> }>;
  runningSubtotals: BillingDocumentSubtotal[];
  quantitiesByUnit: Record<string, number>;
};

/**
 * Resolves one document line list for totals, summaries and display. It is
 * pure so the editor, tax service and PDF/e-invoice adapters share one truth.
 */
export const resolveBillingDocumentLines = (input: readonly BillingDocumentLine[]): BillingDocumentResolution => {
  const lines: BillingLineSummary[] = [];
  const billableLines: BillingLineSummary[] = [];
  const optionalLines: BillingLineSummary[] = [];
  const structuralLines: BillingDocumentLine[] = [];
  const groups: BillingDocumentResolution['groups'] = [];
  const runningSubtotals: BillingDocumentResolution['runningSubtotals'] = [];
  const quantitiesByUnit: Record<string, number> = {};
  const runningQuantities: Record<string, number> = {};
  let currentGroup: BillingDocumentResolution['groups'][number] | undefined;
  let runningAmount = 0;
  let groupSequence = 0;

  input.forEach((line, index) => {
    if (line.kind === 'group') {
      const id = line.groupId?.trim() || `group-${++groupSequence}`;
      currentGroup = { id, label: line.description, amount: 0, quantities: {} };
      groups.push(currentGroup);
      structuralLines.push(line);
      lines.push({ line, amount: 0, groupId: id });
      return;
    }
    if (line.kind === 'summary') {
      const scope = line.summaryScope ?? 'running';
      const groupAmount = currentGroup?.amount ?? 0;
      const quantitySource = scope === 'group' ? currentGroup?.quantities ?? {} : runningQuantities;
      runningSubtotals.push({
        index,
        scope,
        amount: scope === 'group' ? groupAmount : runningAmount,
        quantities: { ...quantitySource },
      });
      if (scope === 'running') {
        runningAmount = 0;
        for (const unit of Object.keys(runningQuantities)) delete runningQuantities[unit];
      }
      structuralLines.push(line);
      lines.push({ line, amount: 0, groupId: currentGroup?.id });
      return;
    }
    const amount = getBillingLineAmount(line);
    const summary = { line, amount, groupId: currentGroup?.id };
    lines.push(summary);
    if (isBillableLine(line)) {
      billableLines.push(summary);
      runningAmount = round2(runningAmount + amount);
      if (currentGroup) {
        currentGroup.amount = round2(currentGroup.amount + amount);
        const unit = line.unit?.trim() || 'Stk.';
        currentGroup.quantities[unit] = (currentGroup.quantities[unit] ?? 0) + finite(line.quantity);
      }
      const unit = line.unit?.trim() || 'Stk.';
      quantitiesByUnit[unit] = (quantitiesByUnit[unit] ?? 0) + finite(line.quantity);
      runningQuantities[unit] = (runningQuantities[unit] ?? 0) + finite(line.quantity);
    } else if (isOptionalLine(line)) {
      optionalLines.push(summary);
    } else {
      structuralLines.push(line);
    }
  });

  return {
    lines,
    billableLines,
    optionalLines,
    structuralLines,
    netAmount: round2(billableLines.reduce((sum, line) => sum + line.amount, 0)),
    groups: groups.map((group) => ({ ...group, quantities: { ...group.quantities } })),
    runningSubtotals,
    quantitiesByUnit,
  };
};
