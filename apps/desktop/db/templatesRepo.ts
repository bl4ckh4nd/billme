import type Database from 'better-sqlite3';
import type { DocumentTemplate, DocumentTemplateKind, InvoiceElement } from '../types';
import { safeJsonParse, TemplateElementsSchema } from './validation-schemas';

type TemplateRow = {
  id: string;
  kind: string;
  name: string;
  elements_json: string;
  created_at: string;
  updated_at: string;
};

type ActiveTemplatesRow = {
  invoice_template_id: string | null;
  offer_template_id: string | null;
};

export const listTemplates = (db: Database.Database, kind?: DocumentTemplateKind): DocumentTemplate[] => {
  const rows = kind
    ? (db
        .prepare('SELECT * FROM templates WHERE kind = ? ORDER BY updated_at DESC')
        .all(kind) as TemplateRow[])
    : (db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as TemplateRow[]);

  return rows.map((r) => ({
    id: r.id,
    kind: (r.kind === 'offer' ? 'offer' : 'invoice') as DocumentTemplateKind,
    name: r.name,
    elements: safeJsonParse(r.elements_json, TemplateElementsSchema, [], `Template ${r.id} elements`) as InvoiceElement[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
};

export const getTemplate = (
  db: Database.Database,
  id: string,
): DocumentTemplate | null => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    kind: (row.kind === 'offer' ? 'offer' : 'invoice') as DocumentTemplateKind,
    name: row.name,
    elements: safeJsonParse(row.elements_json, TemplateElementsSchema, [], `Template ${row.id} elements`) as InvoiceElement[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const upsertTemplate = (
  db: Database.Database,
  template: Omit<DocumentTemplate, 'createdAt' | 'updatedAt'>,
): DocumentTemplate => {
  const now = new Date().toISOString();
  const exists = db.prepare('SELECT 1 FROM templates WHERE id = ?').get(template.id) as
    | { 1: 1 }
    | undefined;

  if (!exists) {
    db.prepare(
      `
        INSERT INTO templates (id, kind, name, elements_json, created_at, updated_at)
        VALUES (@id, @kind, @name, @elementsJson, @createdAt, @updatedAt)
      `,
    ).run({
      id: template.id,
      kind: template.kind,
      name: template.name,
      elementsJson: JSON.stringify(template.elements ?? []),
      createdAt: now,
      updatedAt: now,
    });
    return { ...template, createdAt: now, updatedAt: now };
  }

  const existing = getTemplate(db, template.id);
  const createdAt = existing?.createdAt ?? now;

  db.prepare(
    `
      UPDATE templates SET
        kind=@kind,
        name=@name,
        elements_json=@elementsJson,
        updated_at=@updatedAt
      WHERE id=@id
    `,
  ).run({
    id: template.id,
    kind: template.kind,
    name: template.name,
    elementsJson: JSON.stringify(template.elements ?? []),
    updatedAt: now,
  });

  return { ...template, createdAt, updatedAt: now };
};

export const deleteTemplate = (db: Database.Database, id: string): void => {
  const tx = db.transaction(() => {
    const active = getActiveTemplateIds(db);
    if (active.invoiceTemplateId === id) {
      setActiveTemplateId(db, 'invoice', null);
    }
    if (active.offerTemplateId === id) {
      setActiveTemplateId(db, 'offer', null);
    }
    db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  });

  tx();
};

export const ensureActiveTemplatesRow = (db: Database.Database): void => {
  const row = db.prepare('SELECT 1 FROM active_templates WHERE id = 1').get() as { 1: 1 } | undefined;
  if (row) return;
  db.prepare('INSERT INTO active_templates (id, invoice_template_id, offer_template_id) VALUES (1, NULL, NULL)').run();
};

export const getActiveTemplateIds = (
  db: Database.Database,
): { invoiceTemplateId: string | null; offerTemplateId: string | null } => {
  ensureActiveTemplatesRow(db);
  const row = db
    .prepare('SELECT invoice_template_id, offer_template_id FROM active_templates WHERE id = 1')
    .get() as ActiveTemplatesRow;
  return { invoiceTemplateId: row.invoice_template_id ?? null, offerTemplateId: row.offer_template_id ?? null };
};

export const setActiveTemplateId = (
  db: Database.Database,
  kind: DocumentTemplateKind,
  templateId: string | null,
): void => {
  ensureActiveTemplatesRow(db);
  if (kind === 'invoice') {
    db.prepare('UPDATE active_templates SET invoice_template_id = ? WHERE id = 1').run(templateId);
    return;
  }
  db.prepare('UPDATE active_templates SET offer_template_id = ? WHERE id = 1').run(templateId);
};

export const getActiveTemplate = (
  db: Database.Database,
  kind: DocumentTemplateKind,
): DocumentTemplate | null => {
  const ids = getActiveTemplateIds(db);
  const id = kind === 'invoice' ? ids.invoiceTemplateId : ids.offerTemplateId;
  if (!id) return null;
  return getTemplate(db, id);
};

