import type Database from "better-sqlite3";
import { asc, desc, eq } from "drizzle-orm";
import { createDrizzle, schema } from "./drizzle";
import type {
  DocumentTemplate,
  DocumentTemplateKind,
  InvoiceElement,
} from "@billme/desktop-core/types";
import { safeJsonParse, TemplateElementsSchema } from "./validation-schemas";

export const listTemplates = (
  db: Database.Database,
  kind?: DocumentTemplateKind,
): DocumentTemplate[] => {
  const query = createDrizzle(db).select().from(schema.templates);
  const rows = (kind ? query.where(eq(schema.templates.kind, kind)) : query)
    .orderBy(desc(schema.templates.updatedAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    kind: (r.kind === "offer" ? "offer" : "invoice") as DocumentTemplateKind,
    name: r.name,
    elements: safeJsonParse(
      r.elementsJson,
      TemplateElementsSchema,
      [],
      `Template ${r.id} elements`,
    ) as InvoiceElement[],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
};

export const getTemplate = (
  db: Database.Database,
  id: string,
): DocumentTemplate | null => {
  const r = createDrizzle(db)
    .select()
    .from(schema.templates)
    .where(eq(schema.templates.id, id))
    .get();
  return r
    ? {
        id: r.id,
        kind: (r.kind === "offer"
          ? "offer"
          : "invoice") as DocumentTemplateKind,
        name: r.name,
        elements: safeJsonParse(
          r.elementsJson,
          TemplateElementsSchema,
          [],
          `Template ${r.id} elements`,
        ) as InvoiceElement[],
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    : null;
};

export const upsertTemplate = (
  db: Database.Database,
  template: Omit<DocumentTemplate, "createdAt" | "updatedAt">,
): DocumentTemplate => {
  const now = new Date().toISOString();
  const existing = getTemplate(db, template.id);
  const createdAt = existing?.createdAt ?? now;
  createDrizzle(db)
    .insert(schema.templates)
    .values({
      id: template.id,
      kind: template.kind,
      name: template.name,
      elementsJson: JSON.stringify(template.elements ?? []),
      createdAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.templates.id,
      set: {
        kind: template.kind,
        name: template.name,
        elementsJson: JSON.stringify(template.elements ?? []),
        updatedAt: now,
      },
    })
    .run();
  return { ...template, createdAt, updatedAt: now };
};

export const ensureActiveTemplatesRow = (db: Database.Database): void => {
  createDrizzle(db)
    .insert(schema.activeTemplates)
    .values({ id: 1, invoiceTemplateId: null, offerTemplateId: null })
    .onConflictDoNothing()
    .run();
};

export const getActiveTemplateIds = (
  db: Database.Database,
): { invoiceTemplateId: string | null; offerTemplateId: string | null } => {
  ensureActiveTemplatesRow(db);
  const row = createDrizzle(db)
    .select()
    .from(schema.activeTemplates)
    .where(eq(schema.activeTemplates.id, 1))
    .get();
  return {
    invoiceTemplateId: row?.invoiceTemplateId ?? null,
    offerTemplateId: row?.offerTemplateId ?? null,
  };
};

export const setActiveTemplateId = (
  db: Database.Database,
  kind: DocumentTemplateKind,
  templateId: string | null,
): void => {
  ensureActiveTemplatesRow(db);
  const set =
    kind === "invoice"
      ? { invoiceTemplateId: templateId }
      : { offerTemplateId: templateId };
  createDrizzle(db)
    .update(schema.activeTemplates)
    .set(set)
    .where(eq(schema.activeTemplates.id, 1))
    .run();
};

export const deleteTemplate = (db: Database.Database, id: string): void => {
  const tx = db.transaction(() => {
    const active = getActiveTemplateIds(db);
    if (active.invoiceTemplateId === id)
      setActiveTemplateId(db, "invoice", null);
    if (active.offerTemplateId === id) setActiveTemplateId(db, "offer", null);
    createDrizzle(db)
      .delete(schema.templates)
      .where(eq(schema.templates.id, id))
      .run();
  });
  tx();
};

export const getActiveTemplate = (
  db: Database.Database,
  kind: DocumentTemplateKind,
): DocumentTemplate | null => {
  const ids = getActiveTemplateIds(db);
  return getTemplate(
    db,
    kind === "invoice"
      ? (ids.invoiceTemplateId ?? "")
      : (ids.offerTemplateId ?? ""),
  );
};
