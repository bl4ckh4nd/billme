import {
  calculateInvoiceItemTotal,
  replacePlaceholders,
  type AppSettingsLike,
  type InvoiceLike,
} from './placeholders';

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
  return template.map((el) => {
    if (el.label === 'items_table' || el.type === 'TABLE') {
      const rows = invoice.items.map((item, idx) => ({
        id: idx.toString(),
        cells: [
          (idx + 1).toString(),
          item.description,
          `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`,
          formatCurrency(item.price),
          formatCurrency(calculateInvoiceItemTotal(item)),
        ],
      }));
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
      const content = el.label === 'invoice_meta' ? enrichInvoiceMetaContent(el.content) : el.content;
      return {
        ...el,
        style:
          el.label === 'invoice_meta'
            ? {
                ...el.style,
                height: Math.max(Number(el.style?.height) || 0, 120),
              }
            : el.style,
        content: replacePlaceholders(content, invoice, settings),
      };
    }

    return el;
  });
};
