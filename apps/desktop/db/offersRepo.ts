import type Database from 'better-sqlite3';
import type { Invoice, InvoiceItem } from '../types';
import { appendAuditLog } from './audit';
import { safeJsonParse, AddressSchema } from './validation-schemas';

type OfferRow = {
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
  valid_until: string;
  amount: number;
  status: string;
  share_token: string | null;
  share_published_at: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  accepted_email: string | null;
  accepted_user_agent: string | null;
  decision: string | null;
  decision_text_version: string | null;
  created_at: string;
  updated_at: string;
};

type OfferItemRow = {
  id: number;
  offer_id: string;
  position: number;
  description: string;
  article_id: string | null;
  category: string | null;
  quantity: number;
  price: number;
  total: number;
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

const rowToOffer = (row: OfferRow, items: InvoiceItem[]): Invoice => {
  return {
    id: row.id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddressJson: row.billing_address_json ? safeJsonParse(row.billing_address_json, AddressSchema, {}, `Offer ${row.id} billing address`) : undefined,
    shippingAddressJson: row.shipping_address_json ? safeJsonParse(row.shipping_address_json, AddressSchema, {}, `Offer ${row.id} shipping address`) : undefined,
    shareToken: row.share_token ?? undefined,
    sharePublishedAt: row.share_published_at ?? undefined,
    shareDecision: (row.decision as any) ?? undefined,
    shareDecisionTextVersion: row.decision_text_version ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    acceptedBy: row.accepted_by ?? undefined,
    acceptedEmail: row.accepted_email ?? undefined,
    acceptedUserAgent: row.accepted_user_agent ?? undefined,
    date: row.date,
    dueDate: row.valid_until,
    amount: row.amount,
    status: row.status as any,
    items,
    payments: [],
    history: [],
  };
};

export const markOfferPublished = (
  db: Database.Database,
  offerId: string,
  params: { token: string; publishedAt?: string },
): Invoice => {
  const tx = db.transaction(() => {
    const before = getOffer(db, offerId);
    if (!before) throw new Error('Offer not found');

    const publishedAt = params.publishedAt ?? new Date().toISOString();
    db.prepare('UPDATE offers SET share_token = ?, share_published_at = ?, updated_at = ? WHERE id = ?').run(
      params.token,
      publishedAt,
      publishedAt,
      offerId,
    );

    const after = getOffer(db, offerId)!;
    appendAuditLog(db, {
      entityType: 'offer',
      entityId: offerId,
      action: 'offer.publish',
      reason: null,
      before,
      after,
    });

    return after;
  });

  return tx();
};

export const applyOfferDecision = (
  db: Database.Database,
  offerId: string,
  params: {
    decidedAt: string;
    decision: 'accepted' | 'declined';
    acceptedName: string;
    acceptedEmail: string;
    decisionTextVersion: string;
  },
): Invoice => {
  const tx = db.transaction(() => {
    const before = getOffer(db, offerId);
    if (!before) throw new Error('Offer not found');

    // Idempotent: keep first decision.
    const existing = db
      .prepare('SELECT accepted_at, decision FROM offers WHERE id = ?')
      .get(offerId) as { accepted_at: string | null; decision: string | null } | undefined;
    if (!existing) throw new Error('Offer not found');
    if (existing.accepted_at || existing.decision) return before;

    db.prepare(
      `
        UPDATE offers SET
          accepted_at = @acceptedAt,
          accepted_by = @acceptedBy,
          accepted_email = @acceptedEmail,
          decision = @decision,
          decision_text_version = @decisionTextVersion,
          updated_at = @updatedAt
        WHERE id = @id
      `,
    ).run({
      id: offerId,
      acceptedAt: params.decidedAt,
      acceptedBy: params.acceptedName,
      acceptedEmail: params.acceptedEmail,
      decision: params.decision,
      decisionTextVersion: params.decisionTextVersion,
      updatedAt: new Date().toISOString(),
    });

    const after = getOffer(db, offerId)!;
    appendAuditLog(db, {
      entityType: 'offer',
      entityId: offerId,
      action: 'offer.portal_decision',
      reason: null,
      before,
      after,
    });

    return after;
  });

  return tx();
};

export const listOffersPendingPortalSync = (
  db: Database.Database,
): Array<{ id: string; shareToken: string }> => {
  const rows = db
    .prepare(
      `
        SELECT id, share_token
        FROM offers
        WHERE share_token IS NOT NULL
          AND (decision IS NULL OR decision = '')
          AND accepted_at IS NULL
        ORDER BY share_published_at DESC, updated_at DESC
      `,
    )
    .all() as Array<{ id: string; share_token: string }>;

  return rows
    .filter((r) => Boolean(r.share_token))
    .map((r) => ({ id: r.id, shareToken: r.share_token }));
};

export const listOffers = (db: Database.Database): Invoice[] => {
  const offerRows = db
    .prepare('SELECT * FROM offers ORDER BY date DESC, created_at DESC')
    .all() as OfferRow[];

  const itemRows = db
    .prepare('SELECT * FROM offer_items ORDER BY offer_id, position ASC')
    .all() as OfferItemRow[];

  const itemsByOffer = new Map<string, InvoiceItem[]>();
  for (const r of itemRows) {
    const list = itemsByOffer.get(r.offer_id) ?? [];
    list.push({
      description: r.description,
      articleId: r.article_id ?? undefined,
      category: r.category ?? undefined,
      quantity: r.quantity,
      price: r.price,
      total: r.total,
    });
    itemsByOffer.set(r.offer_id, list);
  }

  const historyByOffer = new Map<string, { date: string; action: string }[]>();
  if (offerRows.length > 0) {
    const ids = offerRows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const auditRows = db
      .prepare(
        `SELECT entity_id, ts, action, reason FROM audit_log
         WHERE entity_type = 'offer' AND entity_id IN (${placeholders})
         ORDER BY sequence DESC`,
      )
      .all(...ids) as AuditRow[];

    for (const r of auditRows) {
      const list = historyByOffer.get(r.entity_id) ?? [];
      list.push(auditToHistoryEntry(r));
      historyByOffer.set(r.entity_id, list);
    }
  }

  return offerRows.map((row) => {
    const offer = rowToOffer(row, itemsByOffer.get(row.id) ?? []);
    offer.history = historyByOffer.get(row.id) ?? [];
    return offer;
  });
};

export const getOffer = (db: Database.Database, id: string): Invoice | null => {
  const row = db.prepare('SELECT * FROM offers WHERE id = ?').get(id) as OfferRow | undefined;
  if (!row) return null;

  const itemRows = db
    .prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY position ASC')
    .all(id) as OfferItemRow[];

  const items: InvoiceItem[] = itemRows.map((r) => ({
    description: r.description,
    articleId: r.article_id ?? undefined,
    category: r.category ?? undefined,
    quantity: r.quantity,
    price: r.price,
    total: r.total,
  }));

  const offer = rowToOffer(row, items);
  const auditRows = db
    .prepare(
      `SELECT entity_id, ts, action, reason FROM audit_log
       WHERE entity_type = 'offer' AND entity_id = ?
       ORDER BY sequence DESC`,
    )
    .all(id) as AuditRow[];
  offer.history = auditRows.map(auditToHistoryEntry);
  return offer;
};

export const deleteOffer = (db: Database.Database, id: string, reason: string) => {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Delete reason is required');
  }

  const tx = db.transaction(() => {
    const before = getOffer(db, id);
    if (!before) throw new Error('Offer not found');

    db.prepare('DELETE FROM offer_items WHERE offer_id = ?').run(id);
    db.prepare('DELETE FROM offers WHERE id = ?').run(id);

    appendAuditLog(db, {
      entityType: 'offer',
      entityId: id,
      action: 'offer.delete',
      reason,
      before,
      after: null,
    });

    return { ok: true } as const;
  });

  return tx();
};

export const upsertOffer = (db: Database.Database, offer: Invoice, reason: string): Invoice => {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Edit reason is required');
  }

  const tx = db.transaction(() => {
    const before = getOffer(db, offer.id);
    const now = new Date().toISOString();

    const exists = db
      .prepare('SELECT 1 FROM offers WHERE id = ?')
      .get(offer.id) as { 1: 1 } | undefined;

    if (!exists) {
      db.prepare(
        `
          INSERT INTO offers (
            id, client_id, client_number, project_id, number, client, client_email, client_address, billing_address_json, shipping_address_json,
            date, valid_until, amount, status,
            share_token, share_published_at, accepted_at, accepted_by, accepted_email, accepted_user_agent,
            created_at, updated_at
          ) VALUES (
            @id, @clientId, @clientNumber, @projectId, @number, @client, @clientEmail, @clientAddress, @billingAddressJson, @shippingAddressJson,
            @date, @validUntil, @amount, @status,
            NULL, NULL, NULL, NULL, NULL, NULL,
            @createdAt, @updatedAt
          )
        `,
      ).run({
        id: offer.id,
        clientId: offer.clientId ?? null,
        clientNumber: offer.clientNumber ?? null,
        projectId: offer.projectId ?? null,
        number: offer.number,
        client: offer.client,
        clientEmail: offer.clientEmail,
        clientAddress: offer.clientAddress ?? null,
        billingAddressJson:
          offer.billingAddressJson === undefined ? null : JSON.stringify(offer.billingAddressJson),
        shippingAddressJson:
          offer.shippingAddressJson === undefined ? null : JSON.stringify(offer.shippingAddressJson),
        date: offer.date,
        validUntil: offer.dueDate,
        amount: offer.amount,
        status: offer.status,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      db.prepare(
        `
          UPDATE offers SET
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
            valid_until=@validUntil,
            amount=@amount,
            status=@status,
            updated_at=@updatedAt
          WHERE id=@id
        `,
      ).run({
        id: offer.id,
        clientId: offer.clientId ?? null,
        clientNumber: offer.clientNumber ?? null,
        projectId: offer.projectId ?? null,
        number: offer.number,
        client: offer.client,
        clientEmail: offer.clientEmail,
        clientAddress: offer.clientAddress ?? null,
        billingAddressJson:
          offer.billingAddressJson === undefined ? null : JSON.stringify(offer.billingAddressJson),
        shippingAddressJson:
          offer.shippingAddressJson === undefined ? null : JSON.stringify(offer.shippingAddressJson),
        date: offer.date,
        validUntil: offer.dueDate,
        amount: offer.amount,
        status: offer.status,
        updatedAt: now,
      });
    }

    db.prepare('DELETE FROM offer_items WHERE offer_id = ?').run(offer.id);
    const insertItem = db.prepare(
      `
        INSERT INTO offer_items (offer_id, position, description, article_id, category, quantity, price, total)
        VALUES (@offerId, @position, @description, @articleId, @category, @quantity, @price, @total)
      `,
    );
    offer.items.forEach((it, idx) => {
      insertItem.run({
        offerId: offer.id,
        position: idx,
        description: it.description,
        articleId: it.articleId ?? null,
        category: it.category ?? null,
        quantity: it.quantity,
        price: it.price,
        total: it.total,
      });
    });

    const after = getOffer(db, offer.id);

    appendAuditLog(db, {
      entityType: 'offer',
      entityId: offer.id,
      action: exists ? 'offer.update' : 'offer.create',
      reason,
      before,
      after,
    });

    return after!;
  });

  return tx();
};
