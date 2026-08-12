import {
  replacePlaceholders,
  type AppSettingsLike,
  type InvoiceLike,
} from './placeholders';
import { billingLineItemSchema, resolveBillingDocumentLines } from '@billme/server-core/domain';

type InvoiceForPreview = Omit<InvoiceLike, 'items'> & {
  items: Array<InvoiceLike['items'][number] & {
    description: string;
    quantity: number;
    price: number;
    total: number;
  }>;
};

type TableColumnLike = {
  id: string;
  label: string;
  width: number;
  visible: boolean;
  align: 'left' | 'center' | 'right';
};

type TableRowLike = {
  id: string;
  cells: string[];
  kind?: 'item' | 'time' | 'optional' | 'text' | 'group' | 'summary';
  groupId?: string;
  groupLabel?: string;
};

type InvoiceElementLike = {
  type?: string;
  label?: string;
  content?: string;
  style?: {
    height?: number;
    [key: string]: unknown;
  };
  tableData?: {
    columns?: TableColumnLike[];
    rows?: TableRowLike[];
  };
  [key: string]: unknown;
};

const enrichInvoiceMetaContent = (content: string): string => {
  let nextContent = content;
  if (!nextContent.includes('{{invoice.servicePeriod}}')) {
    nextContent = `${nextContent}\nLeistungsdatum: {{invoice.servicePeriod}}`;
  }
  if (!nextContent.includes('{{invoice.dueDate}}')) {
    nextContent = `${nextContent}\nFälligkeit: {{invoice.dueDate}}`;
  }
  return nextContent;
};

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

export const getPreviewElements = (
  invoice: InvoiceForPreview,
  template: InvoiceElementLike[],
  settings: AppSettingsLike,
): InvoiceElementLike[] => {
  const hasTaxNotice = Boolean(invoice.taxSnapshot?.taxNotice || invoice.taxMeta?.exemptionReasonOverride || invoice.taxMode && invoice.taxMode !== 'standard_vat');
  let renderedNotice = false;
  const elements = template.map((el) => {
    if (el.label === 'items_table' || el.type === 'TABLE') {
      const normalizedLines = invoice.items.map((item) => billingLineItemSchema.parse({ ...item, kind: item.kind ?? 'item' }));
      const resolved = resolveBillingDocumentLines(normalizedLines);
      const subtotals = new Map(resolved.runningSubtotals.map((subtotal) => [subtotal.index, subtotal]));
      const rows = normalizedLines.map((item, idx) => {
        const kind = item.kind;
        const amount = resolved.lines[idx]?.amount ?? 0;
        const groupId = resolved.lines[idx]?.groupId;
        if (kind === 'group') return { id: idx.toString(), kind, groupId, groupLabel: item.description, cells: ['', item.description, '', '', ''] };
        if (kind === 'text') return { id: idx.toString(), kind, groupId, cells: ['', item.description, '', '', ''] };
        if (kind === 'summary') return {
            id: idx.toString(),
            kind,
            groupId,
            cells: ['', item.description || (item.summaryMetric === 'quantity' ? 'Mengen-Zwischensumme' : 'Zwischensumme'), '', '', item.summaryMetric === 'quantity'
              ? Object.entries(subtotals.get(idx)?.quantities ?? {}).map(([unit, quantity]) => `${quantity} ${unit}`).join(' · ')
            : formatCurrency(subtotals.get(idx)?.amount ?? 0)],
        };
        if (kind === 'optional') return {
          id: idx.toString(),
          kind,
          groupId,
          cells: [(idx + 1).toString(), `${item.description}${item.optionNote ? ` (${item.optionNote})` : ''} – optional`, `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`, formatCurrency(item.price), formatCurrency(0)],
        };
        return {
          id: idx.toString(),
          kind: kind as 'item' | 'time',
          groupId,
          cells: [
            (idx + 1).toString(),
            item.description,
            `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`,
            formatCurrency(item.price),
            formatCurrency(amount),
          ],
        };
      });
      return {
        ...el,
        tableData: {
          columns: el.tableData?.columns || [
            { id: 'pos', label: 'Pos.', width: 40, visible: true, align: 'left' },
            { id: 'desc', label: 'Bezeichnung', width: 280, visible: true, align: 'left' },
            { id: 'qty', label: 'Menge', width: 60, visible: true, align: 'right' },
            { id: 'price', label: 'Einzelpreis', width: 90, visible: true, align: 'right' },
            { id: 'total', label: 'Gesamt', width: 90, visible: true, align: 'right' },
          ],
          rows,
        },
      };
    }

    if (el.type === 'TEXT' && typeof el.content === 'string') {
      let content = el.label === 'invoice_meta' ? enrichInvoiceMetaContent(el.content) : el.content;
      if (hasTaxNotice && content.includes('{{invoice.taxNotice}}')) {
        renderedNotice = true;
      }
      if (hasTaxNotice && !renderedNotice && (el.label === 'totals_block' || el.label === 'payment_terms')) {
        content = `${content}\n{{invoice.taxNotice}}`;
        renderedNotice = true;
      }
      return {
        ...el,
        style: {
          ...el.style,
          ...(el.label === 'invoice_meta' ? { height: Math.max(Number(el.style?.height) || 0, 120) } : {}),
          ...(hasTaxNotice && (el.label === 'totals_block' || el.label === 'payment_terms')
            ? { height: (Number(el.style?.height) || 0) + 30 }
            : {}),
        },
        content: replacePlaceholders(content, invoice, settings),
      };
    }

    return el;
  });
  if (hasTaxNotice && !renderedNotice) {
    elements.push({
      id: 'tax_notice',
      type: 'TEXT',
      x: 76,
      y: 900,
      zIndex: 20,
      content: replacePlaceholders('{{invoice.taxNotice}}', invoice, settings),
      style: { width: 700, height: 40, fontSize: 10, fontWeight: 'bold' },
      label: 'tax_notice',
    });
  }
  return elements;
};
