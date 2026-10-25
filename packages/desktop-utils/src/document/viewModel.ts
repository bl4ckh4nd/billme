import {
  billingLineItemSchema,
  resolveBillingDocumentLines,
  type DocumentTemplateBody,
  type TemplateColumnId,
  type TemplateKind,
  type TemplateLogo,
  type TemplatePresetId,
  type TemplateFont,
} from '@billme/server-core/domain';
import { getInvoiceDocumentLabel } from '@billme/desktop-core/types';
import {
  replacePlaceholders,
  resolveInvoiceTaxSnapshot,
  type AppSettingsLike,
  type InvoiceLike,
} from '../placeholders';
import { PRICE_COLUMNS } from './presets';

export type DocumentRenderInput = {
  kind: TemplateKind;
  template: DocumentTemplateBody;
  document: InvoiceLike;
  settings: AppSettingsLike;
  /** Per-document text overrides from the document editor. */
  texts?: { intro?: string; closing?: string };
  /** The invoice a credit note or cancellation refers to. */
  source?: { number: string; date?: string; documentKind?: InvoiceLike['documentKind'] };
  dunning?: {
    levelName: string;
    date: string;
    payUntil?: string;
    fee: number;
    originalAmount: number;
    paidAmount?: number;
    creditedAmount?: number;
    interest?: number;
    interestRatePercent?: number;
    interestDays?: number;
    flatFee?: boolean;
    daysOverdue: number;
  };
};

export type DocumentColumn = { id: TemplateColumnId; label: string; align: 'left' | 'right' };

export type DocumentRow = {
  id: string;
  kind: 'item' | 'time' | 'optional' | 'text' | 'group' | 'summary' | 'claim';
  cells: Partial<Record<TemplateColumnId, string>>;
};

export type DocumentTotalLine = { label: string; value: string; emphasis?: boolean };

export type DocumentViewModel = {
  kind: TemplateKind;
  presetId: TemplatePresetId;
  accentColor: string;
  font: TemplateFont;
  din: DocumentTemplateBody['din'];
  letterhead: { companyName: string; logo: TemplateLogo | null } | null;
  senderLine: string;
  recipient: string[];
  meta: Array<{ label: string; value: string }>;
  /** Short line for the running header of continuation pages. */
  runningTitle: string;
  title: string;
  intro: string;
  columns: DocumentColumn[];
  rows: DocumentRow[];
  totals: DocumentTotalLine[];
  notice: string;
  closing: string;
  footerColumns: string[][];
};

// A typographic minus keeps negative amounts aligned with tabular figures.
const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount).replace('-', '\u2212');

const formatNumber = (value: number, maximumFractionDigits = 3) =>
  new Intl.NumberFormat('de-DE', { maximumFractionDigits }).format(value);

const formatDate = (value?: string) =>
  value ? new Date(value).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

const RIGHT_ALIGNED: readonly TemplateColumnId[] = ['qty', 'price', 'discount', 'taxRate', 'total'];

const PLACEHOLDER = /\{\{[^}]+\}\}/;

/**
 * Resolves placeholders line by line and drops lines whose placeholders all
 * came back empty, so a missing phone number does not print "Tel. ".
 */
const resolveLines = (text: string, resolve: (value: string) => string): string[] =>
  text.split('\n').flatMap((line) => {
    if (!PLACEHOLDER.test(line)) return [line];
    const withoutValues = line.replace(/\{\{[^}]+\}\}/g, '');
    const resolved = resolve(line);
    const onlyLiteral = resolved.trim() === withoutValues.trim();
    return onlyLiteral ? [] : [resolved];
  });

const trimBlankEdges = (lines: string[]) => {
  const result = [...lines];
  while (result.length && !result[0]!.trim()) result.shift();
  while (result.length && !result[result.length - 1]!.trim()) result.pop();
  return result;
};

const buildItemRows = (input: DocumentRenderInput, unitColumnVisible: boolean): DocumentRow[] => {
  const lines = input.document.items.map((item) => billingLineItemSchema.parse({ ...item, kind: item.kind ?? 'item' }));
  const resolved = resolveBillingDocumentLines(lines);
  const subtotals = new Map(resolved.runningSubtotals.map((subtotal) => [subtotal.index, subtotal]));
  let position = 0;
  return lines.map((item, index): DocumentRow => {
    const id = `row-${index}`;
    if (item.kind === 'group') return { id, kind: 'group', cells: { desc: item.description } };
    if (item.kind === 'text') return { id, kind: 'text', cells: { desc: item.description } };
    if (item.kind === 'summary') {
      const subtotal = subtotals.get(index);
      const value = item.summaryMetric === 'quantity'
        ? Object.entries(subtotal?.quantities ?? {}).map(([unit, quantity]) => `${formatNumber(quantity)} ${unit}`).join(' · ')
        : formatCurrency(subtotal?.amount ?? 0);
      return { id, kind: 'summary', cells: { desc: item.description || 'Zwischensumme', total: value } };
    }
    position += 1;
    const unit = item.unit ?? '';
    const quantity = formatNumber(item.quantity, 6);
    const lineAmount = item.quantity * item.price * (1 - (item.discountPercent ?? 0) / 100) - (item.discountAmount ?? 0);
    const optional = item.kind === 'optional';
    return {
      id,
      kind: optional ? 'optional' : item.kind === 'time' ? 'time' : 'item',
      cells: {
        pos: String(position),
        desc: optional && item.optionNote ? `${item.description}\n${item.optionNote}` : item.description,
        qty: unitColumnVisible || !unit ? quantity : `${quantity} ${unit}`,
        unit,
        price: formatCurrency(item.price),
        discount: item.discountPercent ? `${formatNumber(item.discountPercent)} %` : item.discountAmount ? `−\u00a0${formatCurrency(item.discountAmount)}` : '',
        taxRate: item.taxRate !== undefined ? `${formatNumber(item.taxRate)} %` : '',
        total: optional ? `(${formatCurrency(lineAmount)})` : formatCurrency(resolved.lines[index]?.amount ?? lineAmount),
      },
    };
  });
};

const buildTotals = (input: DocumentRenderInput): DocumentTotalLine[] => {
  if (input.dunning) {
    const { originalAmount, fee, paidAmount = 0, creditedAmount = 0, interest = 0, interestRatePercent, interestDays, flatFee } = input.dunning;
    return [
      { label: 'Rechnungsbetrag', value: formatCurrency(originalAmount) },
      ...(paidAmount > 0 ? [{ label: 'Bereits gezahlt', value: formatCurrency(-paidAmount) }] : []),
      ...(creditedAmount > 0 ? [{ label: 'Gutgeschrieben', value: formatCurrency(-creditedAmount) }] : []),
      ...(fee > 0 ? [{ label: flatFee ? 'Pauschale nach § 288 Abs. 5 BGB' : 'Mahngebühr', value: formatCurrency(fee) }] : []),
      ...(interest > 0 ? [{ label: `Verzugszinsen ${formatNumber(interestRatePercent ?? 0)} % p. a. für ${interestDays} Tage`, value: formatCurrency(interest) }] : []),
      { label: 'Offener Betrag', value: formatCurrency(originalAmount - paidAmount - creditedAmount + fee + interest), emphasis: true },
    ];
  }
  const snapshot = resolveInvoiceTaxSnapshot(input.document, input.settings);
  const breakdown = snapshot.vatBreakdown?.length
    ? snapshot.vatBreakdown
    : [{ rate: snapshot.vatRateApplied, netAmount: snapshot.netAmount, vatAmount: snapshot.vatAmount }];
  const vatLines = breakdown
    .filter((entry) => entry.rate > 0)
    .map((entry) => ({
      label: breakdown.length > 1
        ? `USt. ${formatNumber(entry.rate)} % auf ${formatCurrency(entry.netAmount)}`
        : `USt. ${formatNumber(entry.rate)} %`,
      value: formatCurrency(entry.vatAmount),
    }));
  // Skonto is printed with its deadline and the amount payable, so the customer can pay it exactly.
  const skonto = input.document.skonto;
  const skontoUntil = skonto && input.document.date
    ? new Date(Date.parse(`${input.document.date.slice(0, 10)}T00:00:00Z`) + skonto.days * 86_400_000).toISOString().slice(0, 10)
    : undefined;
  return [
    ...(vatLines.length ? [{ label: 'Nettobetrag', value: formatCurrency(snapshot.netAmount) }, ...vatLines] : []),
    { label: 'Gesamtbetrag', value: formatCurrency(snapshot.grossAmount), emphasis: true },
    ...(skonto && skontoUntil ? [{
      label: `Bei Zahlung bis ${formatDate(skontoUntil)} abzüglich ${formatNumber(skonto.percent)} % Skonto`,
      value: formatCurrency(Math.round(snapshot.grossAmount * (100 - skonto.percent)) / 100),
    }] : []),
  ];
};

const withoutNoDeductionClause = (value: string, skonto: boolean) => (skonto ? value.replace(/ ohne Abzug/g, '') : value);

export const buildDocumentViewModel = (input: DocumentRenderInput): DocumentViewModel => {
  const { template, document, settings, kind } = input;
  const visible = (section: keyof DocumentTemplateBody['sections']) => template.sections[section]?.visible !== false;
  const sourceLabel = input.source ? getInvoiceDocumentLabel(input.source.documentKind) : '';
  const extra: Record<string, string> = {
    'offer.validUntil': formatDate(document.dueDate),
    'source.label': sourceLabel,
    'source.number': input.source?.number ?? '',
    'source.date': formatDate(input.source?.date),
    ...(input.dunning
      ? {
          'dunning.levelName': input.dunning.levelName,
          'dunning.date': formatDate(input.dunning.date),
          'dunning.payUntil': formatDate(input.dunning.payUntil),
          'dunning.fee': formatCurrency(input.dunning.fee),
          'dunning.daysOverdue': String(input.dunning.daysOverdue),
          'dunning.openAmount': formatCurrency(input.dunning.originalAmount - (input.dunning.paidAmount ?? 0) - (input.dunning.creditedAmount ?? 0) + input.dunning.fee + (input.dunning.interest ?? 0)),
          'dunning.interest': formatCurrency(input.dunning.interest ?? 0),
        }
      : {}),
  };
  const resolve = (value: string) => replacePlaceholders(value, document, settings, extra);
  const text = (value: string) => trimBlankEdges(resolveLines(value, resolve)).join('\n');

  const priceHidden = kind === 'delivery_note';
  // A discounted position always shows its discount (§14 Abs. 4 Nr. 7 UStG), even if the template hides the column.
  const hasDiscount = (document.items ?? []).some((item) => (item.discountPercent ?? 0) > 0 || (item.discountAmount ?? 0) > 0);
  const templateColumns = template.columns.filter((column) =>
    (column.visible || (column.id === 'discount' && hasDiscount)) && !(priceHidden && PRICE_COLUMNS.includes(column.id)),
  );
  const unitColumnVisible = templateColumns.some((column) => column.id === 'unit');
  const columns = templateColumns.map((column) => ({
    id: column.id,
    label: column.label,
    align: RIGHT_ALIGNED.includes(column.id) ? 'right' as const : 'left' as const,
  }));

  const rows: DocumentRow[] = input.dunning
    ? [{
        id: 'claim',
        kind: 'claim',
        cells: {
          desc: `${getInvoiceDocumentLabel(document.documentKind)} ${document.number}`,
          date: formatDate(document.date),
          dueDate: formatDate(document.dueDate),
          total: formatCurrency(input.dunning.originalAmount),
        },
      }]
    : buildItemRows(input, unitColumnVisible);

  const notice = input.dunning || priceHidden ? '' : resolve('{{invoice.taxNotice}}');

  const recipient = trimBlankEdges([document.client, ...(document.clientAddress ?? '').split('\n')])
    .filter((line, index, all) => index === 0 || line !== all[0]);

  const title = `${document.status === 'draft' && !input.dunning ? 'ENTWURF · ' : ''}${text(template.texts.title)}`;
  return {
    kind,
    presetId: template.presetId,
    accentColor: template.accentColor,
    font: template.font,
    din: template.din,
    letterhead: visible('letterhead') ? { companyName: settings.company.name, logo: template.logo } : null,
    senderLine: visible('addressBlock') ? text(template.texts.senderLine) : '',
    recipient: visible('addressBlock') ? recipient : [],
    meta: visible('meta')
      ? template.texts.meta
          .map((entry) => ({ label: text(entry.label), value: text(entry.value) }))
          .filter((entry) => entry.value.trim() !== '')
      : [],
    runningTitle: title,
    title: visible('title') || document.status === 'draft' ? title : '',
    intro: visible('intro') ? text(input.texts?.intro ?? template.texts.intro) : '',
    columns,
    rows: visible('items') ? rows : [],
    totals: visible('totals') && !priceHidden ? buildTotals(input) : [],
    notice: notice.trim(),
    // "ohne Abzug" in a standard closing would contradict agreed Skonto terms printed in the totals.
    closing: visible('closing') ? withoutNoDeductionClause(text(input.texts?.closing ?? template.texts.closing), Boolean(document.skonto)) : '',
    footerColumns: visible('footer')
      ? template.texts.footerColumns.map((column) => trimBlankEdges(resolveLines(column, resolve))).filter((lines) => lines.length > 0)
      : [],
  };
};
