import type Database from 'better-sqlite3';

export interface EmailLogEntry {
  id: string;
  documentType: 'invoice' | 'offer';
  documentId: string;
  documentNumber: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  bodyText: string;
  provider: 'smtp' | 'resend';
  status: 'sent' | 'failed';
  errorMessage?: string;
  sentAt: string;
  createdAt: string;
}

export const logEmail = (db: Database.Database, entry: EmailLogEntry): void => {
  db.prepare(
    `
      INSERT INTO email_log (
        id, document_type, document_id, document_number,
        recipient_email, recipient_name, subject, body_text,
        provider, status, error_message, sent_at, created_at
      ) VALUES (
        @id, @documentType, @documentId, @documentNumber,
        @recipientEmail, @recipientName, @subject, @bodyText,
        @provider, @status, @errorMessage, @sentAt, @createdAt
      )
    `,
  ).run({
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
  });
};

export const listEmailsForDocument = (
  db: Database.Database,
  documentType: 'invoice' | 'offer',
  documentId: string,
): EmailLogEntry[] => {
  const rows = db
    .prepare(
      `
        SELECT * FROM email_log
        WHERE document_type = ? AND document_id = ?
        ORDER BY sent_at DESC
      `,
    )
    .all(documentType, documentId) as Array<{
    id: string;
    document_type: string;
    document_id: string;
    document_number: string;
    recipient_email: string;
    recipient_name: string;
    subject: string;
    body_text: string;
    provider: string;
    status: string;
    error_message: string | null;
    sent_at: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    documentType: r.document_type as 'invoice' | 'offer',
    documentId: r.document_id,
    documentNumber: r.document_number,
    recipientEmail: r.recipient_email,
    recipientName: r.recipient_name,
    subject: r.subject,
    bodyText: r.body_text,
    provider: r.provider as 'smtp' | 'resend',
    status: r.status as 'sent' | 'failed',
    errorMessage: r.error_message ?? undefined,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  }));
};
