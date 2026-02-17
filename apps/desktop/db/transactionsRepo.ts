import type Database from 'better-sqlite3';
import { upsertInvoice, getInvoice } from './invoicesRepo';
import type { Invoice } from '../types';
import { v4 as uuidv4 } from 'uuid';

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
  const rows = db
    .prepare(
      `
        SELECT * FROM transactions
        WHERE type = 'income'
          AND (linked_invoice_id IS NULL OR linked_invoice_id = '')
        ORDER BY date DESC, amount DESC
      `,
    )
    .all() as Array<{
    id: string;
    account_id: string;
    date: string;
    amount: number;
    type: string;
    counterparty: string;
    purpose: string;
    linked_invoice_id: string | null;
    status: string;
    dedup_hash: string | null;
    import_batch_id: string | null;
  }>;

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
): InvoiceMatchSuggestion[] => {
  // Get all open invoices
  const invoiceRows = db
    .prepare(
      `
        SELECT * FROM invoices
        WHERE status IN ('open', 'overdue')
        ORDER BY date DESC
      `,
    )
    .all() as Array<{ id: string; [key: string]: unknown }>;

  const suggestions: InvoiceMatchSuggestion[] = [];

  for (const row of invoiceRows) {
    const invoice = getInvoice(db, row.id);
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
): { success: boolean; invoice?: Invoice } => {
  return db.transaction(() => {
    // Get transaction
    const txRow = db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(transactionId) as { id: string; date: string; amount: number; linked_invoice_id: string | null; counterparty: string; [key: string]: unknown } | undefined;

    if (!txRow) {
      throw new Error('Transaction not found');
    }

    // Get invoice
    const invoice = getInvoice(db, invoiceId);
    if (!invoice) {
      throw new Error('Invoice not found');
    }

    // Check if already linked
    if (txRow.linked_invoice_id) {
      throw new Error('Transaction is already linked to an invoice');
    }

    // Link transaction
    db.prepare('UPDATE transactions SET linked_invoice_id = ? WHERE id = ?').run(
      invoiceId,
      transactionId,
    );

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
      updatedInvoice,
      `Automatisch verknüpft mit Transaktion (${txRow.counterparty}, ${txRow.amount}€)`,
    );

    return { success: true, invoice: saved };
  })();
};

/**
 * Unlink a transaction from an invoice
 */
export const unlinkTransactionFromInvoice = (
  db: Database.Database,
  transactionId: string,
): { success: boolean } => {
  return db.transaction(() => {
    // Get transaction
    const txRow = db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(transactionId) as { id: string; date: string; amount: number; linked_invoice_id: string | null; [key: string]: unknown } | undefined;

    if (!txRow) {
      throw new Error('Transaction not found');
    }

    if (!txRow.linked_invoice_id) {
      throw new Error('Transaction is not linked to any invoice');
    }

    const invoiceId: string = txRow.linked_invoice_id;

    // Unlink transaction
    db.prepare('UPDATE transactions SET linked_invoice_id = NULL WHERE id = ?').run(transactionId);

    // Get invoice and remove payment
    const invoice = getInvoice(db, invoiceId);
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

      upsertInvoice(db, updatedInvoice, `Verknüpfung mit Transaktion aufgehoben`);
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
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params: unknown[] = [];

  if (filters?.accountId) {
    query += ' AND account_id = ?';
    params.push(filters.accountId);
  }

  if (filters?.type) {
    query += ' AND type = ?';
    params.push(filters.type);
  }

  if (filters?.linkedOnly) {
    query += ' AND linked_invoice_id IS NOT NULL';
  }

  if (filters?.unlinkedOnly) {
    query += " AND (linked_invoice_id IS NULL OR linked_invoice_id = '')";
  }

  query += ' ORDER BY date DESC, amount DESC';

  const rows = db.prepare(query).all(...params) as Array<{
    id: string;
    account_id: string;
    date: string;
    amount: number;
    type: string;
    counterparty: string;
    purpose: string;
    linked_invoice_id: string | null;
    status: string;
    dedup_hash: string | null;
    import_batch_id: string | null;
  }>;

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
