import type Database from 'better-sqlite3';
import type { Invoice, InvoiceItem, InvoiceTaxMode, Payment } from '../types';
import { appendAuditLog } from './audit';
import {
  safeJsonParse,
  AddressSchema,
  InvoiceTaxMetaSchema,
  InvoiceTaxSnapshotSchema,
  SettingsSchema,
} from './validation-schemas';
import { finalizeNumber, reserveNumber } from './numberingRepo';
import { resolveInvoiceTaxMode } from '../services/taxMode';

type InvoiceRow = {
  id: string;
  client_id: string | null;
  client_number: string | null;
  project_id: string | null;
  number: string;
  client: string;
  client_email: string;
  client_address: string | null;
  billing_address_json: string | null;
  shipping_address_json: string | null;
  date: string;
  due_date: string;
  service_period: string | null;
  tax_mode: string | null;
  tax_meta_json: string | null;
  tax_snapshot_json: string | null;
  amount: number;
  status: string;
  dunning_level: number;
  created_at: string;
  updated_at: string;
};

type InvoiceItemRow = {
  id: number;
  invoice_id: string;
  position: number;
  description: string;
  article_id: string | null;
  category: string | null;
  quantity: number;
  price: number;
  total: number;
};

type InvoicePaymentRow = {
  id: string;
  invoice_id: string;
  date: string;
  amount: number;
  method: string;
};

type AuditRow = {
  entity_id: string;
  ts: string;
  action: string;
  reason: string | null;
};

const auditToHistoryEntry = (row: AuditRow) => {
  const date = row.ts.split('T')[0] ?? row.ts;
  const action = row.reason ? `${row.action} (${row.reason})` : row.action;
  return { date, action };
};

const rowToInvoice = (
  row: InvoiceRow,
  items: InvoiceItem[],
  payments: Payment[],
): Invoice => {
  const taxMode = resolveInvoiceTaxMode(row.tax_mode as InvoiceTaxMode | undefined);
  return {
    id: row.id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddressJson: row.billing_address_json ? safeJsonParse(row.billing_address_json, AddressSchema, {}, `Invoice ${row.id} billing address`) : undefined,
    shippingAddressJson: row.shipping_address_json ? safeJsonParse(row.shipping_address_json, AddressSchema, {}, `Invoice ${row.id} shipping address`) : undefined,
    date: row.date,
    dueDate: row.due_date,
    servicePeriod: row.service_period ?? undefined,
    taxMode,
    taxMeta: row.tax_meta_json
      ? safeJsonParse(row.tax_meta_json, InvoiceTaxMetaSchema, {}, `Invoice ${row.id} tax meta`)
      : undefined,
    taxSnapshot: row.tax_snapshot_json
      ? safeJsonParse(
          row.tax_snapshot_json,
          InvoiceTaxSnapshotSchema,
          {
            vatRateApplied: 0,
            vatAmount: 0,
            netAmount: 0,
            grossAmount: 0,
          },
          `Invoice ${row.id} tax snapshot`,
        )
      : undefined,
    amount: row.amount,
    status: row.status as 'draft' | 'open' | 'paid' | 'overdue' | 'cancelled',
    dunningLevel: row.dunning_level,
    items,
    payments,
    history: [], // derived later from audit_log
  };
};

export const listInvoices = (db: Database.Database): Invoice[] => {
  const invoiceRows = db
    .prepare('SELECT * FROM invoices ORDER BY date DESC, created_at DESC')
    .all() as InvoiceRow[];

  const itemRows = db
    .prepare('SELECT * FROM invoice_items ORDER BY invoice_id, position ASC')
    .all() as InvoiceItemRow[];

  const paymentRows = db
    .prepare('SELECT * FROM invoice_payments ORDER BY invoice_id, date DESC')
    .all() as InvoicePaymentRow[];

  const itemsByInvoice = new Map<string, InvoiceItem[]>();
  for (const r of itemRows) {
    const list = itemsByInvoice.get(r.invoice_id) ?? [];
    list.push({
      description: r.description,
      articleId: r.article_id ?? undefined,
      category: r.category ?? undefined,
      quantity: r.quantity,
      price: r.price,
      total: r.total,
    });
    itemsByInvoice.set(r.invoice_id, list);
  }

  const paymentsByInvoice = new Map<string, Payment[]>();
  for (const r of paymentRows) {
    const list = paymentsByInvoice.get(r.invoice_id) ?? [];
    list.push({
      id: r.id,
      date: r.date,
      amount: r.amount,
      method: r.method,
    });
    paymentsByInvoice.set(r.invoice_id, list);
  }

  const historyByInvoice = new Map<string, { date: string; action: string }[]>();
  if (invoiceRows.length > 0) {
    const ids = invoiceRows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const auditRows = db
      .prepare(
        `SELECT entity_id, ts, action, reason FROM audit_log
         WHERE entity_type = 'invoice' AND entity_id IN (${placeholders})
         ORDER BY sequence DESC`,
      )
      .all(...ids) as AuditRow[];

    for (const r of auditRows) {
      const list = historyByInvoice.get(r.entity_id) ?? [];
      list.push(auditToHistoryEntry(r));
      historyByInvoice.set(r.entity_id, list);
    }
  }

  return invoiceRows.map((row) => {
    const invoice = rowToInvoice(
      row,
      itemsByInvoice.get(row.id) ?? [],
      paymentsByInvoice.get(row.id) ?? [],
    );
    invoice.history = historyByInvoice.get(row.id) ?? [];
    return invoice;
  });
};

export const upsertInvoice = (
  db: Database.Database,
  invoice: Invoice,
  reason: string,
): Invoice => {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Edit reason is required');
  }

  const tx = db.transaction(() => {
    const before = getInvoice(db, invoice.id);

    const taxMode = resolveInvoiceTaxMode(invoice.taxMode);
    const taxSnapshot = invoice.taxSnapshot ?? null;

    const now = new Date().toISOString();

    const exists = db
      .prepare('SELECT 1 FROM invoices WHERE id = ?')
      .get(invoice.id) as { 1: 1 } | undefined;

    if (!exists) {
      db.prepare(
        `
          INSERT INTO invoices (
            id, client_id, client_number, project_id, number, client, client_email, client_address, billing_address_json, shipping_address_json,
            date, due_date, service_period, tax_mode, tax_meta_json, tax_snapshot_json, amount, status, dunning_level,
            created_at, updated_at
          ) VALUES (
            @id, @clientId, @clientNumber, @projectId, @number, @client, @clientEmail, @clientAddress, @billingAddressJson, @shippingAddressJson,
            @date, @dueDate, @servicePeriod, @taxMode, @taxMetaJson, @taxSnapshotJson, @amount, @status, @dunningLevel,
            @createdAt, @updatedAt
          )
        `,
      ).run({
        id: invoice.id,
        clientId: invoice.clientId ?? null,
        clientNumber: invoice.clientNumber ?? null,
        projectId: invoice.projectId ?? null,
        number: invoice.number,
        client: invoice.client,
        clientEmail: invoice.clientEmail,
        clientAddress: invoice.clientAddress ?? null,
        billingAddressJson:
          invoice.billingAddressJson === undefined ? null : JSON.stringify(invoice.billingAddressJson),
        shippingAddressJson:
          invoice.shippingAddressJson === undefined ? null : JSON.stringify(invoice.shippingAddressJson),
        date: invoice.date,
        dueDate: invoice.dueDate,
        servicePeriod: invoice.servicePeriod ?? null,
        taxMode,
        taxMetaJson: invoice.taxMeta === undefined ? null : JSON.stringify(invoice.taxMeta),
        taxSnapshotJson: taxSnapshot ? JSON.stringify(taxSnapshot) : null,
        amount: invoice.amount,
        status: invoice.status,
        dunningLevel: invoice.dunningLevel ?? 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      db.prepare(
        `
          UPDATE invoices SET
            client_id=@clientId,
            client_number=@clientNumber,
            project_id=@projectId,
            number=@number,
            client=@client,
            client_email=@clientEmail,
            client_address=@clientAddress,
            billing_address_json=@billingAddressJson,
            shipping_address_json=@shippingAddressJson,
            date=@date,
            due_date=@dueDate,
            service_period=@servicePeriod,
            tax_mode=@taxMode,
            tax_meta_json=@taxMetaJson,
            tax_snapshot_json=@taxSnapshotJson,
            amount=@amount,
            status=@status,
            dunning_level=@dunningLevel,
            updated_at=@updatedAt
          WHERE id=@id
        `,
      ).run({
        id: invoice.id,
        clientId: invoice.clientId ?? null,
        clientNumber: invoice.clientNumber ?? null,
        projectId: invoice.projectId ?? null,
        number: invoice.number,
        client: invoice.client,
        clientEmail: invoice.clientEmail,
        clientAddress: invoice.clientAddress ?? null,
        billingAddressJson:
          invoice.billingAddressJson === undefined ? null : JSON.stringify(invoice.billingAddressJson),
        shippingAddressJson:
          invoice.shippingAddressJson === undefined ? null : JSON.stringify(invoice.shippingAddressJson),
        date: invoice.date,
        dueDate: invoice.dueDate,
        servicePeriod: invoice.servicePeriod ?? null,
        taxMode,
        taxMetaJson: invoice.taxMeta === undefined ? null : JSON.stringify(invoice.taxMeta),
        taxSnapshotJson: taxSnapshot ? JSON.stringify(taxSnapshot) : null,
        amount: invoice.amount,
        status: invoice.status,
        dunningLevel: invoice.dunningLevel ?? 0,
        updatedAt: now,
      });
    }

    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoice.id);
    const insertItem = db.prepare(
      `
        INSERT INTO invoice_items (invoice_id, position, description, article_id, category, quantity, price, total)
        VALUES (@invoiceId, @position, @description, @articleId, @category, @quantity, @price, @total)
      `,
    );
    invoice.items.forEach((it, idx) => {
      insertItem.run({
        invoiceId: invoice.id,
        position: idx,
        description: it.description,
        articleId: it.articleId ?? null,
        category: it.category ?? null,
        quantity: it.quantity,
        price: it.price,
        total: it.total,
      });
    });

    db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(invoice.id);
    const insertPayment = db.prepare(
      `
        INSERT INTO invoice_payments (id, invoice_id, date, amount, method)
        VALUES (@id, @invoiceId, @date, @amount, @method)
      `,
    );
    invoice.payments.forEach((p) => {
      insertPayment.run({
        id: p.id,
        invoiceId: invoice.id,
        date: p.date,
        amount: p.amount,
        method: p.method,
      });
    });

    const after = getInvoice(db, invoice.id);
    if (!after) {
      throw new Error('Failed to retrieve invoice after upsert');
    }

    appendAuditLog(db, {
      entityType: 'invoice',
      entityId: invoice.id,
      action: exists ? 'invoice.update' : 'invoice.create',
      reason,
      before,
      after,
    });

    return after;
  });

  return tx();
};

export const getInvoice = (db: Database.Database, id: string): Invoice | null => {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
  if (!row) return null;

  const itemRows = db
    .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position ASC')
    .all(id) as InvoiceItemRow[];

  const paymentRows = db
    .prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY date DESC')
    .all(id) as InvoicePaymentRow[];

  const items: InvoiceItem[] = itemRows.map((r) => ({
    description: r.description,
    articleId: r.article_id ?? undefined,
    category: r.category ?? undefined,
    quantity: r.quantity,
    price: r.price,
    total: r.total,
  }));

  const payments: Payment[] = paymentRows.map((r) => ({
    id: r.id,
    date: r.date,
    amount: r.amount,
    method: r.method,
  }));

  const invoice = rowToInvoice(row, items, payments);
  const auditRows = db
    .prepare(
      `SELECT entity_id, ts, action, reason FROM audit_log
       WHERE entity_type = 'invoice' AND entity_id = ?
       ORDER BY sequence DESC`,
    )
    .all(id) as AuditRow[];
  invoice.history = auditRows.map(auditToHistoryEntry);
  return invoice;
};

export const deleteInvoice = (db: Database.Database, id: string, reason: string) => {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Delete reason is required');
  }

  const tx = db.transaction(() => {
    const before = getInvoice(db, id);
    if (!before) throw new Error('Invoice not found');

    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);

    appendAuditLog(db, {
      entityType: 'invoice',
      entityId: id,
      action: 'invoice.delete',
      reason,
      before,
      after: null,
    });

    return { ok: true } as const;
  });

  return tx();
};

export const createInvoiceFromOffer = (
  db: Database.Database,
  offerId: string,
  newInvoiceId: string,
): Invoice => {
  const tx = db.transaction(() => {
    // Get the offer data
    const offerRow = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId) as any;
    if (!offerRow) throw new Error('Offer not found');

    // Get offer items
    const offerItemRows = db
      .prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY position ASC')
      .all(offerId) as any[];

    const numberReservation = reserveNumber(db, 'invoice');
    const invoiceNumber = numberReservation.number;

    // Get settings for invoice due date defaults
    const settingsRow = db.prepare('SELECT settings_json FROM settings WHERE id = 1').get() as
      | { settings_json: string }
      | undefined;

    // Calculate due date (payment terms days from settings or default 14)
    const paymentTerms = settingsRow
      ? safeJsonParse(settingsRow.settings_json, SettingsSchema, { legal: { paymentTermsDays: 14 } } as any, 'Settings for payment terms').legal?.paymentTermsDays || 14
      : 14;

    const invoiceDate = new Date().toISOString().split('T')[0] ?? '';
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + paymentTerms);
    const dueDateStr = dueDate.toISOString().split('T')[0] ?? '';

    const now = new Date().toISOString();

    // Create the invoice
    db.prepare(
      `
        INSERT INTO invoices (
          id, client_id, client_number, project_id, number, client, client_email, client_address,
          billing_address_json, shipping_address_json,
          date, due_date, service_period, tax_mode, tax_meta_json, tax_snapshot_json, amount, status, dunning_level,
          created_at, updated_at
        ) VALUES (
          @id, @clientId, @clientNumber, @projectId, @number, @client, @clientEmail, @clientAddress,
          @billingAddressJson, @shippingAddressJson,
          @date, @dueDate, @servicePeriod, @taxMode, @taxMetaJson, @taxSnapshotJson, @amount, @status, @dunningLevel,
          @createdAt, @updatedAt
        )
      `,
    ).run({
      id: newInvoiceId,
      clientId: offerRow.client_id,
      clientNumber: offerRow.client_number,
      projectId: offerRow.project_id,
      number: invoiceNumber,
      client: offerRow.client,
      clientEmail: offerRow.client_email,
      clientAddress: offerRow.client_address,
      billingAddressJson: offerRow.billing_address_json,
      shippingAddressJson: offerRow.shipping_address_json,
      date: invoiceDate,
      dueDate: dueDateStr,
      servicePeriod: null,
      taxMode: offerRow.tax_mode ?? 'standard_vat',
      taxMetaJson: offerRow.tax_meta_json ?? null,
      taxSnapshotJson: offerRow.tax_snapshot_json ?? null,
      amount: offerRow.amount,
      status: 'draft',
      dunningLevel: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Copy items
    const insertItem = db.prepare(
      `
        INSERT INTO invoice_items (invoice_id, position, description, article_id, category, quantity, price, total)
        VALUES (@invoiceId, @position, @description, @articleId, @category, @quantity, @price, @total)
      `,
    );

    offerItemRows.forEach((item: any, idx: number) => {
      insertItem.run({
        invoiceId: newInvoiceId,
        position: idx,
        description: item.description,
        articleId: item.article_id,
        category: item.category,
        quantity: item.quantity,
        price: item.price,
        total: item.total,
      });
    });

    const invoice = getInvoice(db, newInvoiceId);
    if (!invoice) throw new Error('Failed to create invoice');
    finalizeNumber(db, numberReservation.reservationId, newInvoiceId);

    // Add audit log entry
    appendAuditLog(db, {
      entityType: 'invoice',
      entityId: newInvoiceId,
      action: 'invoice.create',
      reason: `Converted from offer ${offerRow.number}`,
      before: null,
      after: invoice,
    });

    return invoice;
  });

  return tx();
};
