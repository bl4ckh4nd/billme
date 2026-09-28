import {
  documentLayoutSchema,
  documentTemplateBodySchema,
  freezeDocumentLayout,
  resolveDocumentTemplate,
  type DocumentLayout,
  type DocumentTemplateBody,
  type TemplateKind,
} from '@billme/server-core';
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresQueryable } from './connection.js';
import { createDrizzle, schema } from './drizzle.js';
import { getServerDocumentTemplateDefaults, listServerDocumentTemplates } from './proAccounting.js';

const drizzleDb = (db: PostgresQueryable) => createDrizzle(db as never);

const parseLayout = (value: string | null | undefined): DocumentLayout | undefined => {
  if (!value) return undefined;
  const parsed = documentLayoutSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : undefined;
};

/**
 * A document rendered with the shipped preset still needs a version to point
 * at. The preset body goes into the append-only version log under a per-tenant
 * id, with a new version only when a release changed the preset. It never
 * appears in the template list.
 */
const ensurePresetVersion = async (
  db: PostgresQueryable,
  tenantId: string,
  kind: TemplateKind,
  body: DocumentTemplateBody,
): Promise<{ id: string; version: number }> => {
  const id = `preset-${tenantId}-${kind}`;
  const bodyJson = JSON.stringify(body);
  const latest = (await drizzleDb(db).select().from(schema.documentTemplateVersions)
    .where(and(eq(schema.documentTemplateVersions.templateId, id), eq(schema.documentTemplateVersions.tenantId, tenantId)))
    .orderBy(desc(schema.documentTemplateVersions.version)).limit(1))[0];
  if (latest && latest.bodyJson === bodyJson) return { id, version: latest.version! };
  const version = (latest?.version ?? 0) + 1;
  // Two first issues at once (API save and a recurring run) may both get here;
  // the loser keeps the winner's row, which holds the same preset body.
  await drizzleDb(db).insert(schema.documentTemplateVersions).values({
    templateId: id, version, tenantId, kind, bodyJson, createdAt: new Date().toISOString(),
  }).onConflictDoNothing();
  return { id, version };
};

/**
 * The layout a save stores. Drafts keep what the writer sent. The first save
 * outside draft freezes template version and sender data; once frozen, the
 * snapshot survives every later save, whatever the writer sends.
 */
export const resolveLayoutForSave = async (
  db: PostgresQueryable,
  input: {
    tenantId: string;
    kind: TemplateKind;
    status: string;
    table: 'invoices' | 'offers';
    id: string;
    layout: DocumentLayout | undefined;
  },
): Promise<DocumentLayout | undefined> => {
  const table = input.table === 'offers' ? schema.offers : schema.invoices;
  const existingRow = (await drizzleDb(db).select({ layoutJson: table.layoutJson }).from(table)
    .where(and(eq(table.id, input.id), eq(table.tenantId, input.tenantId))).limit(1))[0];
  const existing = parseLayout(existingRow?.layoutJson);
  // The snapshot is server-owned: whatever a writer sends for it is ignored.
  const { snapshot: _sent, ...sent } = input.layout ?? {};
  const own = input.layout ? sent : undefined;
  if (existing?.snapshot) return { ...(own ?? existing), snapshot: existing.snapshot };
  if (input.status === 'draft') return own;

  const layout = own ?? existing;
  const templates = (await listServerDocumentTemplates(db, input.tenantId))
    .filter((record) => record.kind === input.kind)
    .map((record) => ({ ...record, body: documentTemplateBodySchema.parse(JSON.parse(record.bodyJson)) }));
  const resolved = resolveDocumentTemplate(input.kind, {
    templateId: layout?.templateId,
    templates,
    defaults: await getServerDocumentTemplateDefaults(db, input.tenantId),
  });
  const template = resolved.id && resolved.version
    ? { id: resolved.id, version: resolved.version }
    : await ensurePresetVersion(db, input.tenantId, input.kind, resolved.body);

  const settingsRow = (await drizzleDb(db).select({ settingsJson: schema.serverSettings.settingsJson })
    .from(schema.serverSettings).where(eq(schema.serverSettings.tenantId, input.tenantId)).limit(1))[0];
  const settings = settingsRow?.settingsJson ? JSON.parse(settingsRow.settingsJson) as Record<string, unknown> : {};
  // Only whole objects: render-context overlays them onto the current settings.
  const sender = Object.fromEntries(['company', 'finance'].filter((key) => settings[key]).map((key) => [key, settings[key]]));

  return freezeDocumentLayout(layout, template, sender, new Date().toISOString());
};
