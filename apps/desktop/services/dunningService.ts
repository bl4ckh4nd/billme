import type Database from 'better-sqlite3';
import { getSettings } from '../db/settingsRepo';
import { listInvoices, upsertInvoice, getInvoice } from '../db/invoicesRepo';
import { logEmail } from '../db/emailRepo';
import { sendEmail, type SmtpConfig, type ResendConfig, type EmailOptions } from './emailService';
import { v4 as uuidv4 } from 'uuid';
import type { Invoice, AppSettings, DunningLevel } from '../types';
import { isRetryableEmailError } from '../utils/retry';
import { logger } from '../utils/logger';

interface DunningHistoryEntry {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  dunningLevel: number;
  daysOverdue: number;
  feeApplied: number;
  emailSent: boolean;
  emailLogId?: string;
  processedAt: string;
  createdAt: string;
}

interface DunningResult {
  processedInvoices: number;
  emailsSent: number;
  feesApplied: number;
  errors: Array<{ invoiceNumber: string; error: string }>;
}

/**
 * Get dunning history for an invoice
 */
const getDunningHistory = (db: Database.Database, invoiceId: string): DunningHistoryEntry[] => {
  const rows = db
    .prepare(
      `
        SELECT * FROM dunning_history
        WHERE invoice_id = ?
        ORDER BY dunning_level DESC, processed_at DESC
      `,
    )
    .all(invoiceId) as Array<{
    id: string;
    invoice_id: string;
    invoice_number: string;
    dunning_level: number;
    days_overdue: number;
    fee_applied: number;
    email_sent: number;
    email_log_id: string | null;
    processed_at: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    dunningLevel: r.dunning_level,
    daysOverdue: r.days_overdue,
    feeApplied: r.fee_applied,
    emailSent: r.email_sent === 1,
    emailLogId: r.email_log_id ?? undefined,
    processedAt: r.processed_at,
    createdAt: r.created_at,
  }));
};

/**
 * Record dunning action in history
 */
const recordDunningHistory = (
  db: Database.Database,
  entry: Omit<DunningHistoryEntry, 'id' | 'createdAt'>,
): void => {
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO dunning_history (
        id, invoice_id, invoice_number, dunning_level, days_overdue,
        fee_applied, email_sent, email_log_id, processed_at, created_at
      ) VALUES (
        @id, @invoiceId, @invoiceNumber, @dunningLevel, @daysOverdue,
        @feeApplied, @emailSent, @emailLogId, @processedAt, @createdAt
      )
    `,
  ).run({
    id: uuidv4(),
    invoiceId: entry.invoiceId,
    invoiceNumber: entry.invoiceNumber,
    dunningLevel: entry.dunningLevel,
    daysOverdue: entry.daysOverdue,
    feeApplied: entry.feeApplied,
    emailSent: entry.emailSent ? 1 : 0,
    emailLogId: entry.emailLogId ?? null,
    processedAt: entry.processedAt,
    createdAt: now,
  });
};

/**
 * Calculate days overdue for an invoice
 */
const calculateDaysOverdue = (dueDate: string): number => {
  const due = new Date(dueDate);
  const now = new Date();
  const diffMs = now.getTime() - due.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
};

/**
 * Determine which dunning level applies based on days overdue
 */
const determineDunningLevel = (
  daysOverdue: number,
  dunningLevels: DunningLevel[],
): DunningLevel | null => {
  // Filter only enabled levels
  const enabledLevels = dunningLevels.filter((level) => level.enabled);

  // Sort levels by daysAfterDueDate descending to find the highest applicable level
  const sorted = [...enabledLevels].sort((a, b) => b.daysAfterDueDate - a.daysAfterDueDate);

  for (const level of sorted) {
    if (daysOverdue >= level.daysAfterDueDate) {
      return level;
    }
  }

  return null;
};

/**
 * Replace placeholders in dunning email template
 */
const replacePlaceholders = (
  template: string,
  invoice: Invoice,
  daysOverdue: number,
  dunningLevel: DunningLevel,
): string => {
  const replacements: Record<string, string> = {
    '%N': invoice.number,
    '%D': new Date(invoice.dueDate).toLocaleDateString('de-DE'),
    '%A': invoice.amount.toFixed(2),
    '%T': daysOverdue.toString(),
    '%F': dunningLevel.fee.toFixed(2),
    '%K': invoice.client,
  };

  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(key, 'g'), value);
  }

  return result;
};

/**
 * Process dunning for all overdue invoices
 */
export const processDunningRun = async (
  db: Database.Database,
  secrets: {
    get: (key: 'smtp.password' | 'resend.apiKey') => Promise<string | null>;
  },
): Promise<DunningResult> => {
  const result: DunningResult = {
    processedInvoices: 0,
    emailsSent: 0,
    feesApplied: 0,
    errors: [],
  };

  const settings = getSettings(db);
  if (!settings) {
    throw new Error('Settings not configured');
  }

  if (!settings.automation.dunningEnabled) {
    throw new Error('Dunning automation is not enabled');
  }

  const enabledLevels = settings.dunning.levels.filter((level) => level.enabled);
  if (enabledLevels.length === 0) {
    throw new Error('No dunning levels are enabled');
  }

  if (settings.email.provider === 'none') {
    throw new Error('Email provider not configured. Cannot send dunning reminders.');
  }

  // Get all overdue invoices
  const allInvoices = listInvoices(db);
  const overdueInvoices = allInvoices.filter((inv) => inv.status === 'overdue');

  if (overdueInvoices.length === 0) {
    return result; // No overdue invoices
  }

  // Get provider credentials
  let providerConfig: SmtpConfig | ResendConfig;
  if (settings.email.provider === 'smtp') {
    const smtpPassword = await secrets.get('smtp.password');
    if (!smtpPassword) {
      throw new Error('SMTP password not configured');
    }
    providerConfig = {
      host: settings.email.smtpHost,
      port: settings.email.smtpPort,
      secure: settings.email.smtpSecure,
      auth: {
        user: settings.email.smtpUser,
        pass: smtpPassword,
      },
    } as SmtpConfig;
  } else {
    const resendApiKey = await secrets.get('resend.apiKey');
    if (!resendApiKey) {
      throw new Error('Resend API key not configured');
    }
    providerConfig = {
      apiKey: resendApiKey,
    } as ResendConfig;
  }

  const now = new Date().toISOString();

  // Process each overdue invoice
  for (const invoice of overdueInvoices) {
    try {
      const daysOverdue = calculateDaysOverdue(invoice.dueDate);
      if (daysOverdue <= 0) continue; // Not actually overdue

      // Determine dunning level
      const applicableLevel = determineDunningLevel(daysOverdue, settings.dunning.levels);
      if (!applicableLevel) continue; // No level applies yet

      // Check dunning history to avoid duplicate reminders
      const history = getDunningHistory(db, invoice.id);

      // Check for successful send at this level
      const successfulSend = history.find(
        (h) => h.dunningLevel === applicableLevel.id && h.emailSent === true
      );

      if (successfulSend) {
        logger.debug('DunningService', 'Already sent successful reminder at this level', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
        });
        continue; // Skip - already sent successfully
      }

      // Check for failed sends that should be retried
      const failedSends = history.filter(
        (h) => h.dunningLevel === applicableLevel.id && h.emailSent === false
      );

      if (failedSends.length >= 3) {
        logger.warn('DunningService', 'Max retry attempts reached, skipping', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          retryCount: failedSends.length,
        });
        continue; // Max retries reached, give up
      }

      if (failedSends.length > 0) {
        logger.info('DunningService', 'Retrying failed dunning send', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          attempt: failedSends.length + 1,
        });
      }

      // Apply dunning fee if not already applied at this level
      let feeApplied = 0;
      if (applicableLevel.fee > 0) {
        // Add fee to invoice amount
        const updatedInvoice = {
          ...invoice,
          amount: invoice.amount + applicableLevel.fee,
        };

        upsertInvoice(
          db,
          updatedInvoice,
          `Mahngebühr Stufe ${applicableLevel.id} (${applicableLevel.fee.toFixed(2)}€)`,
        );

        feeApplied = applicableLevel.fee;
        result.feesApplied += feeApplied;
      }

      // Prepare and send email
      const subject = replacePlaceholders(applicableLevel.subject, invoice, daysOverdue, applicableLevel);
      const bodyText = replacePlaceholders(applicableLevel.text, invoice, daysOverdue, applicableLevel);

      const emailOptions: EmailOptions = {
        from: {
          name: settings.email.fromName || settings.company.name,
          email: settings.email.fromEmail || settings.company.email,
        },
        to: {
          name: invoice.client,
          email: invoice.clientEmail,
        },
        subject,
        text: bodyText,
      };

      const emailResult = await sendEmail(settings.email.provider, providerConfig, emailOptions);

      // Log email
      const emailLogId = uuidv4();
      logEmail(db, {
        id: emailLogId,
        documentType: 'invoice',
        documentId: invoice.id,
        documentNumber: invoice.number,
        recipientEmail: invoice.clientEmail,
        recipientName: invoice.client,
        subject,
        bodyText,
        provider: settings.email.provider,
        status: emailResult.success ? 'sent' : 'failed',
        errorMessage: emailResult.error,
        sentAt: now,
        createdAt: now,
      });

      // Record dunning history based on email success
      if (emailResult.success) {
        recordDunningHistory(db, {
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          daysOverdue,
          feeApplied,
          emailSent: true,
          emailLogId,
          processedAt: now,
        });

        result.emailsSent++;
        logger.info('DunningService', 'Dunning email sent successfully', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
        });
      } else {
        // Email failed - record failure for retry
        recordDunningHistory(db, {
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          daysOverdue,
          feeApplied,
          emailSent: false,
          emailLogId: undefined,
          processedAt: now,
        });

        logger.error('DunningService', 'Dunning email failed', undefined, {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          error: emailResult.error,
        });

        result.errors.push({
          invoiceNumber: invoice.number,
          error: `Email failed: ${emailResult.error}`,
        });
      }

      result.processedInvoices++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableEmailError(error);

      result.errors.push({
        invoiceNumber: invoice.number,
        error: `${errorMsg}${retryable ? ' (will retry)' : ' (permanent failure)'}`,
      });

      logger.error('DunningService', 'Failed to process invoice', error as Error, {
        invoiceNumber: invoice.number,
        retryable,
      });
    }
  }

  // Update last dunning run time
  settings.automation.lastDunningRun = now;
  db.prepare('UPDATE settings SET settings_json = ? WHERE id = 1').run(JSON.stringify(settings));

  return result;
};

/**
 * Get dunning status for an invoice
 */
export const getInvoiceDunningStatus = (
  db: Database.Database,
  invoiceId: string,
): {
  currentLevel: number;
  daysOverdue: number;
  lastReminderSent?: string;
  totalFeesApplied: number;
  history: DunningHistoryEntry[];
} => {
  const invoice = getInvoice(db, invoiceId);
  if (!invoice) {
    throw new Error('Invoice not found');
  }

  const history = getDunningHistory(db, invoiceId);
  const daysOverdue = invoice.status === 'overdue' ? calculateDaysOverdue(invoice.dueDate) : 0;

  const currentLevel = history.length > 0 ? Math.max(...history.map((h) => h.dunningLevel)) : 0;
  const lastReminderSent = history.find((h) => h.emailSent)?.processedAt;
  const totalFeesApplied = history.reduce((sum, h) => sum + h.feeApplied, 0);

  return {
    currentLevel,
    daysOverdue,
    lastReminderSent,
    totalFeesApplied,
    history,
  };
};
