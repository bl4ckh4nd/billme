import type Database from 'better-sqlite3';
import { and, desc, eq, isNull, isNotNull, or, inArray } from 'drizzle-orm';
import { upsertInvoice, getInvoice } from './invoicesRepo';
import type { Invoice } from '@billme/desktop-core/types';
import type { ServerProduct } from '@billme/server-core';
import { v4 as uuidv4 } from 'uuid';
import { createDrizzle, schema } from './drizzle';

const transactionSelection = {
  id: schema.transactions.id,
  account_id: schema.transactions.accountId,
  date: schema.transactions.date,
  amount: schema.transactions.amount,
  type: schema.transactions.type,
  counterparty: schema.transactions.counterparty,
  purpose: schema.transactions.purpose,
  linked_invoice_id: schema.transactions.linkedInvoiceId,
  status: schema.transactions.status,
  dedup_hash: schema.transactions.dedupHash,
  import_batch_id: schema.transactions.importBatchId,
};

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  type: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  linkedInvoiceId?: string;
  status: 'pending' | 'booked';
  dedupHash?: string;
  importBatchId?: string;
}

export interface InvoiceMatchSuggestion {
  invoice: Invoice;
  confidence: 'high' | 'medium' | 'low';
  matchReasons: string[];
  amountDiff: number;
}

/**
 * Get all unmatched transactions (income only)
 */
export const getUnmatchedTransactions = (db: Database.Database): Transaction[] => {
  const rows = createDrizzle(db).select(transactionSelection).from(schema.transactions)
    .where(and(eq(schema.transactions.type, 'income'), or(isNull(schema.transactions.linkedInvoiceId), eq(schema.transactions.linkedInvoiceId, ''))))
    .orderBy(desc(schema.transactions.date), desc(schema.transactions.amount)).all();

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    amount: r.amount,
    type: r.type as 'income' | 'expense',
    counterparty: r.counterparty,
    purpose: r.purpose,
    linkedInvoiceId: r.linked_invoice_id ?? undefined,
    status: r.status as 'pending' | 'booked',
    dedupHash: r.dedup_hash ?? undefined,
    importBatchId: r.import_batch_id ?? undefined,
  }));
};

/**
 * Smart matching: Find invoice suggestions for a transaction
 */
export const findInvoiceMatches = (
  db: Database.Database,
  transaction: Transaction,
  product: ServerProduct,
): InvoiceMatchSuggestion[] => {
  // Get all open invoices
  const invoiceRows = createDrizzle(db).select({ id: schema.invoices.id }).from(schema.invoices)
    .where(inArray(schema.invoices.status, ['open', 'overdue'])).orderBy(desc(schema.invoices.date)).all();

  const suggestions: InvoiceMatchSuggestion[] = [];

  for (const row of invoiceRows) {
    const invoice = getInvoice(db, product, row.id) as Invoice | null;
    if (!invoice) continue;

    const matchReasons: string[] = [];
    let confidence: 'high' | 'medium' | 'low' = 'low';

    // Calculate how much is already paid
    const alreadyPaid = (invoice.payments ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
    const remainingAmount = invoice.amount - alreadyPaid;
    const amountDiff = Math.abs(transaction.amount - remainingAmount);

    // Match by amount (within 5 EUR tolerance for fees)
    const amountMatch = amountDiff <= 5;
    if (amountMatch) {
      matchReasons.push(`Betrag stimmt überein (±${amountDiff.toFixed(2)}€)`);
      confidence = 'high';
    } else if (amountDiff <= remainingAmount * 0.1) {
      // Within 10% tolerance
      matchReasons.push(`Betrag ähnlich (${amountDiff.toFixed(2)}€ Differenz)`);
      confidence = confidence === 'low' ? 'medium' : confidence;
    }

    // Match by invoice number in transaction purpose
    const purposeLower = transaction.purpose.toLowerCase();
    const numberLower = invoice.number.toLowerCase();
    if (purposeLower.includes(numberLower)) {
      matchReasons.push(`Rechnungsnummer in Verwendungszweck`);
      confidence = 'high';
    }

    // Match by client name in counterparty
    const counterpartyLower = transaction.counterparty.toLowerCase();
    const clientLower = invoice.client.toLowerCase();
    const clientWords = clientLower.split(/\s+/).filter((w) => w.length > 2);

    let clientNameMatch = false;
    for (const word of clientWords) {
      if (counterpartyLower.includes(word)) {
        clientNameMatch = true;
        break;
      }
    }

    if (clientNameMatch) {
      matchReasons.push(`Kundenname im Auftraggeber`);
      if (confidence === 'low') confidence = 'medium';
    }

    // Match by date proximity (within 14 days of due date)
    const transactionDate = new Date(transaction.date);
    const dueDate = new Date(invoice.dueDate);
    const daysDiff = Math.abs((transactionDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDiff <= 14) {
      matchReasons.push(`Zahlung nahe Fälligkeitsdatum (${Math.floor(daysDiff)} Tage)`);
      if (confidence === 'low') confidence = 'medium';
    }

    // Only include if we have at least one match reason
    if (matchReasons.length > 0) {
      suggestions.push({
        invoice,
        confidence,
        matchReasons,
        amountDiff,
      });
    }
  }

  // Sort by confidence (high first) then by amount difference
  suggestions.sort((a, b) => {
    const confidenceOrder = { high: 3, medium: 2, low: 1 };
    const confDiff = confidenceOrder[b.confidence] - confidenceOrder[a.confidence];
    if (confDiff !== 0) return confDiff;
    return a.amountDiff - b.amountDiff;
  });

  return suggestions.slice(0, 5); // Top 5 suggestions
};

/**
 * Link a transaction to an invoice and create payment record
 */
export const linkTransactionToInvoice = (
  db: Database.Database,
  transactionId: string,
  invoiceId: string,
  product: ServerProduct,
): { success: boolean; invoice?: Invoice } => {
  return db.transaction(() => {
    // Get transaction
    const txRow = createDrizzle(db).select({
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      linked_invoice_id: schema.transactions.linkedInvoiceId,
      counterparty: schema.transactions.counterparty,
    }).from(schema.transactions).where(eq(schema.transactions.id, transactionId)).get() as { id?: string; date: string; amount: number; linked_invoice_id: string | null; counterparty: string } | undefined;

    if (!txRow) {
      throw new Error('Transaction not found');
    }

    // Get invoice
    const invoice = getInvoice(db, product, invoiceId) as Invoice | null;
    if (!invoice) {
      throw new Error('Invoice not found');
    }

    // Check if already linked
    if (txRow.linked_invoice_id) {
      throw new Error('Transaction is already linked to an invoice');
    }

    // Link transaction
    createDrizzle(db).update(schema.transactions).set({ linkedInvoiceId: invoiceId })
      .where(eq(schema.transactions.id, transactionId)).run();

    // Create payment record
    const paymentId = uuidv4();
    const payment = {
      id: paymentId,
      date: txRow.date,
      amount: txRow.amount,
      method: 'Überweisung',
    };

    const updatedInvoice = {
      ...invoice,
      payments: [...(invoice.payments ?? []), payment],
    };

    // Calculate total paid
    const totalPaid = updatedInvoice.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const isPaid = totalPaid >= invoice.amount;

    // Update status if fully paid
    if (isPaid && updatedInvoice.status !== 'paid') {
      updatedInvoice.status = 'paid';
    }

    // Save invoice with new payment
    const saved = upsertInvoice(
      db,
      product,
      updatedInvoice,
      `Automatisch verknüpft mit Transaktion (${txRow.counterparty}, ${txRow.amount}€)`,
    ) as unknown as Invoice;

    return { success: true, invoice: saved };
  })();
};

/**
 * Unlink a transaction from an invoice
 */
export const unlinkTransactionFromInvoice = (
  db: Database.Database,
  transactionId: string,
  product: ServerProduct,
): { success: boolean } => {
  return db.transaction(() => {
    // Get transaction
    const txRow = createDrizzle(db).select({
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      linked_invoice_id: schema.transactions.linkedInvoiceId,
    }).from(schema.transactions).where(eq(schema.transactions.id, transactionId)).get() as { date: string; amount: number; linked_invoice_id: string | null } | undefined;

    if (!txRow) {
      throw new Error('Transaction not found');
    }

    if (!txRow.linked_invoice_id) {
      throw new Error('Transaction is not linked to any invoice');
    }

    const invoiceId: string = txRow.linked_invoice_id;

    // Unlink transaction
    createDrizzle(db).update(schema.transactions).set({ linkedInvoiceId: null })
      .where(eq(schema.transactions.id, transactionId)).run();

    // Get invoice and remove payment
    const invoice = getInvoice(db, product, invoiceId) as Invoice | null;
    if (invoice) {
      // Find and remove the payment that matches this transaction
      const updatedPayments = (invoice.payments ?? []).filter((p) => {
        // Match by date and amount
        return !(p.date === txRow.date && Number(p.amount) === Number(txRow.amount));
      });

      const updatedInvoice = {
        ...invoice,
        payments: updatedPayments,
        status: updatedPayments.length === 0 ? ('open' as const) : invoice.status,
      };

      upsertInvoice(db, product, updatedInvoice, `Verknüpfung mit Transaktion aufgehoben`);
    }

    return { success: true };
  })();
};

/**
 * Get all transactions (with optional filters)
 */
export const listTransactions = (
  db: Database.Database,
  filters?: {
    accountId?: string;
    type?: 'income' | 'expense';
    linkedOnly?: boolean;
    unlinkedOnly?: boolean;
  },
): Transaction[] => {
  const conditions = [];
  if (filters?.accountId) conditions.push(eq(schema.transactions.accountId, filters.accountId));
  if (filters?.type) conditions.push(eq(schema.transactions.type, filters.type));
  if (filters?.linkedOnly) conditions.push(isNotNull(schema.transactions.linkedInvoiceId));
  if (filters?.unlinkedOnly) conditions.push(or(isNull(schema.transactions.linkedInvoiceId), eq(schema.transactions.linkedInvoiceId, '')));
  const rows = createDrizzle(db).select(transactionSelection).from(schema.transactions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.transactions.date), desc(schema.transactions.amount)).all();

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    amount: r.amount,
    type: r.type as 'income' | 'expense',
    counterparty: r.counterparty,
    purpose: r.purpose,
    linkedInvoiceId: r.linked_invoice_id ?? undefined,
    status: r.status as 'pending' | 'booked',
    dedupHash: r.dedup_hash ?? undefined,
    importBatchId: r.import_batch_id ?? undefined,
  }));
};
