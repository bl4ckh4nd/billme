import type Database from "better-sqlite3";
import { asc, desc, and, eq } from "drizzle-orm";
import { createDrizzle, schema } from "./drizzle";

export interface EmailLogEntry {
  id: string;
  documentType: "invoice" | "offer";
  documentId: string;
  documentNumber: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  bodyText: string;
  provider: "smtp" | "resend";
  status: "sent" | "failed";
  errorMessage?: string;
  sentAt: string;
  createdAt: string;
}

export const logEmail = (db: Database.Database, entry: EmailLogEntry): void => {
  createDrizzle(db)
    .insert(schema.emailLog)
    .values({
      id: entry.id,
      documentType: entry.documentType,
      documentId: entry.documentId,
      documentNumber: entry.documentNumber,
      recipientEmail: entry.recipientEmail,
      recipientName: entry.recipientName,
      subject: entry.subject,
      bodyText: entry.bodyText,
      provider: entry.provider,
      status: entry.status,
      errorMessage: entry.errorMessage ?? null,
      sentAt: entry.sentAt,
      createdAt: entry.createdAt,
    })
    .run();
};

export const listEmailsForDocument = (
  db: Database.Database,
  documentType: "invoice" | "offer",
  documentId: string,
): EmailLogEntry[] => {
  const rows = createDrizzle(db)
    .select()
    .from(schema.emailLog)
    .where(
      and(
        eq(schema.emailLog.documentType, documentType),
        eq(schema.emailLog.documentId, documentId),
      ),
    )
    .orderBy(desc(schema.emailLog.sentAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    documentType: r.documentType as EmailLogEntry["documentType"],
    documentId: r.documentId,
    documentNumber: r.documentNumber,
    recipientEmail: r.recipientEmail,
    recipientName: r.recipientName,
    subject: r.subject,
    bodyText: r.bodyText,
    provider: r.provider as EmailLogEntry["provider"],
    status: r.status as EmailLogEntry["status"],
    errorMessage: r.errorMessage ?? undefined,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
  }));
};
