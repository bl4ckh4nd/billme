import type { Invoice } from '@billme/desktop-core/types';
import { isCorrectionDocumentKind, isReceivableDocumentKind } from '@billme/server-core/services';

/**
 * The documents that are revenue and receivables, with their amount lowered by
 * issued credit notes and Stornos. Order confirmations, delivery notes and the
 * corrections themselves drop out, so totals neither double count an order nor
 * add a credit note as income.
 */
export const billingDocuments = (invoices: readonly Invoice[]): Invoice[] => {
  const credited = new Map<string, number>();
  for (const document of invoices) {
    if (!isCorrectionDocumentKind(document.documentKind) || document.status === 'draft' || !document.sourceDocumentId) continue;
    credited.set(document.sourceDocumentId, (credited.get(document.sourceDocumentId) ?? 0) + document.amount);
  }
  return invoices
    .filter((document) => isReceivableDocumentKind(document.documentKind))
    .map((document) => {
      const credit = credited.get(document.id);
      return credit ? { ...document, amount: Math.max(0, Math.round((document.amount - credit) * 100) / 100) } : document;
    });
};
