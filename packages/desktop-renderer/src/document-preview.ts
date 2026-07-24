import type { AppSettings, Invoice, InvoiceElement } from '@billme/desktop-core/types';
import { getPreviewElements as sharedGetPreviewElements } from '@billme/desktop-utils/documentPreview';

export const getPreviewElements = (
  invoice: Invoice,
  template: InvoiceElement[],
  settings: AppSettings,
): InvoiceElement[] =>
  sharedGetPreviewElements(
    invoice as unknown as Parameters<typeof sharedGetPreviewElements>[0],
    template as unknown as Parameters<typeof sharedGetPreviewElements>[1],
    settings as unknown as Parameters<typeof sharedGetPreviewElements>[2],
  ) as unknown as InvoiceElement[];
