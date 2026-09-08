import type {
  DunningHistoryEntry,
  DunningLevel,
  DunningRunResult,
  DunningSettings,
  InvoiceDunningStatus,
} from '../domain/dunning.js';
import type { Invoice, TenantScope } from '../domain/foundations.js';
import { systemClock, type AuditActor, type AuditLogPort, type Clock, type DunningEmailPort, type DunningHistoryRepository, type DunningSecretPort, type DunningSettingsRepository, type InvoiceRepository } from '../ports/index.js';

type LoggerPort = Pick<Console, 'debug' | 'error' | 'info' | 'warn'>;

type RetryClassifier = (error: unknown) => boolean;

type AsyncInvoiceRepository = Pick<InvoiceRepository, 'getById' | 'list' | 'save'>;
type AsyncAuditLogPort = Pick<AuditLogPort, 'append'>;

export interface DunningDomainDependencies<TSettings extends DunningSettings = DunningSettings> {
  invoiceRepo: AsyncInvoiceRepository;
  settingsRepo: DunningSettingsRepository<TSettings>;
  dunningHistoryRepo: DunningHistoryRepository;
  emailPort: DunningEmailPort;
  secretStore: DunningSecretPort;
  auditLog: AsyncAuditLogPort;
  clock?: Clock;
  actor?: AuditActor;
  logger?: LoggerPort;
  isRetryableError?: RetryClassifier;
}

const defaultActor: AuditActor = {
  type: 'system',
  displayName: 'local',
};

const buildAuditSubject = (scope: TenantScope, invoiceId: string) => ({
  entityType: 'invoice',
  entityId: invoiceId,
  tenantId: scope.tenantId,
});

const isSameDay = (left: Date, right: Date): boolean => {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
};

const buildProviderConfig = async <TSettings extends DunningSettings>(
  settings: TSettings,
  secretStore: DunningSecretPort,
): Promise<
  | {
      provider: 'smtp';
      config: {
        host: string;
        port: number;
        secure: boolean;
        auth: {
          user: string;
          pass: string;
        };
      };
    }
  | {
      provider: 'resend';
      config: {
        apiKey: string;
      };
    }
> => {
  if (settings.email.provider === 'none') {
    throw new Error('Email provider not configured. Cannot send dunning reminders.');
  }

  if (settings.email.provider === 'smtp') {
    const smtpPassword = await secretStore.get('smtp.password');
    if (!smtpPassword) {
      throw new Error('SMTP password not configured');
    }

    return {
      provider: 'smtp',
      config: {
        host: settings.email.smtpHost,
        port: settings.email.smtpPort,
        secure: settings.email.smtpSecure,
        auth: {
          user: settings.email.smtpUser,
          pass: smtpPassword,
        },
      },
    };
  }

  const resendApiKey = await secretStore.get('resend.apiKey');
  if (!resendApiKey) {
    throw new Error('Resend API key not configured');
  }

  return {
    provider: 'resend',
    config: {
      apiKey: resendApiKey,
    },
  };
};

export const shouldRunScheduledDunning = <TSettings extends Pick<DunningSettings, 'automation'>>(
  settings: TSettings | null | undefined,
  now = new Date(),
  windowMinutes = 15,
): boolean => {
  if (!settings?.automation.dunningEnabled) {
    return false;
  }

  const [hourRaw, minuteRaw] = settings.automation.dunningRunTime.split(':');
  const targetHour = Number(hourRaw);
  const targetMinute = Number(minuteRaw);
  if (!Number.isFinite(targetHour) || !Number.isFinite(targetMinute)) {
    return false;
  }

  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const isTargetTime =
    currentHour === targetHour && currentMinute >= targetMinute && currentMinute < targetMinute + windowMinutes;

  if (!isTargetTime) {
    return false;
  }

  if (!settings.automation.lastDunningRun) {
    return true;
  }

  return !isSameDay(new Date(settings.automation.lastDunningRun), now);
};

export const calculateDaysOverdue = (dueDate: string, now = new Date()): number => {
  const due = new Date(dueDate);
  const diffMs = now.getTime() - due.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
};

export const determineDunningLevel = (daysOverdue: number, dunningLevels: DunningLevel[]): DunningLevel | null => {
  const enabledLevels = dunningLevels.filter((level) => level.enabled);
  const sorted = [...enabledLevels].sort((left, right) => right.daysAfterDueDate - left.daysAfterDueDate);

  for (const level of sorted) {
    if (daysOverdue >= level.daysAfterDueDate) {
      return level;
    }
  }

  return null;
};

export const replaceDunningPlaceholders = (
  template: string,
  invoice: Pick<Invoice, 'amount' | 'client' | 'dueDate' | 'number'>,
  daysOverdue: number,
  dunningLevel: Pick<DunningLevel, 'fee'>,
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

export const summarizeInvoiceDunningStatus = (
  invoice: Pick<Invoice, 'dueDate' | 'status'> | null,
  history: DunningHistoryEntry[],
  now = new Date(),
): InvoiceDunningStatus => {
  if (!invoice) {
    throw new Error('Invoice not found');
  }

  const daysOverdue = invoice.status === 'overdue' ? calculateDaysOverdue(invoice.dueDate, now) : 0;
  const currentLevel = history.length > 0 ? Math.max(...history.map((entry) => entry.dunningLevel)) : 0;
  const lastReminderSent = history
    .filter((entry) => entry.emailSent)
    .sort((left, right) => right.processedAt.localeCompare(left.processedAt))[0]?.processedAt;
  const totalFeesApplied = history.reduce((sum, entry) => sum + entry.feeApplied, 0);

  return {
    currentLevel,
    daysOverdue,
    lastReminderSent,
    totalFeesApplied,
    history,
  };
};

export const processDunningRun = async <TSettings extends DunningSettings>(
  scope: TenantScope,
  dependencies: DunningDomainDependencies<TSettings>,
): Promise<DunningRunResult> => {
  const result: DunningRunResult = {
    processedInvoices: 0,
    emailsSent: 0,
    feesApplied: 0,
    errors: [],
  };

  const settings = await dependencies.settingsRepo.get(scope);
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

  const overdueInvoices = (await dependencies.invoiceRepo.list(scope)).filter((invoice) =>
    invoice.status === 'overdue' &&
    !['order_confirmation', 'delivery_note'].includes(invoice.documentKind ?? 'invoice'),
  );
  if (overdueInvoices.length === 0) {
    return result;
  }

  const providerConfig = await buildProviderConfig(settings, dependencies.secretStore);
  const clock = dependencies.clock ?? systemClock;
  const logger = dependencies.logger;
  const actor = dependencies.actor ?? defaultActor;
  const runStartedAt = clock.nowIso();
  const runStartedDate = clock.now();

  for (const invoice of overdueInvoices) {
    try {
      const daysOverdue = calculateDaysOverdue(invoice.dueDate, runStartedDate);
      if (daysOverdue <= 0) {
        continue;
      }

      const applicableLevel = determineDunningLevel(daysOverdue, settings.dunning.levels);
      if (!applicableLevel) {
        continue;
      }

      const history = await dependencies.dunningHistoryRepo.listByInvoice(scope, invoice.id);
      const successfulSend = history.find(
        (entry) => entry.dunningLevel === applicableLevel.id && entry.emailSent,
      );

      if (successfulSend) {
        logger?.debug?.('DunningService already sent successful reminder', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
        });
        continue;
      }

      const failedSends = history.filter(
        (entry) => entry.dunningLevel === applicableLevel.id && !entry.emailSent,
      );
      if (failedSends.length >= 3) {
        logger?.warn?.('DunningService max retry attempts reached', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          retryCount: failedSends.length,
        });
        continue;
      }

      if (failedSends.length > 0) {
        logger?.info?.('DunningService retrying failed send', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          attempt: failedSends.length + 1,
        });
      }

      const feeAlreadyApplied = history.some(
        (entry) => entry.dunningLevel === applicableLevel.id && entry.feeApplied > 0,
      );

      let feeApplied = 0;
      if (applicableLevel.fee > 0 && !feeAlreadyApplied) {
        const before = invoice;
        const after = await dependencies.invoiceRepo.save(scope, {
          ...invoice,
          amount: invoice.amount + applicableLevel.fee,
        });

        feeApplied = applicableLevel.fee;
        result.feesApplied += feeApplied;

        await dependencies.auditLog.append(scope, {
          occurredAt: runStartedAt,
          action: 'invoice.update',
          reason: `Mahngebühr Stufe ${applicableLevel.id} (${applicableLevel.fee.toFixed(2)}€)`,
          actor,
          subject: buildAuditSubject(scope, invoice.id),
          change: {
            before,
            after,
          },
        });
      }

      const subject = replaceDunningPlaceholders(applicableLevel.subject, invoice, daysOverdue, applicableLevel);
      const bodyText = replaceDunningPlaceholders(applicableLevel.text, invoice, daysOverdue, applicableLevel);
      const emailResult = await dependencies.emailPort.send(providerConfig.provider, providerConfig.config, {
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
      });

      const emailLog = await dependencies.emailPort.log(scope, {
        documentType: 'invoice',
        documentId: invoice.id,
        documentNumber: invoice.number,
        recipientEmail: invoice.clientEmail,
        recipientName: invoice.client,
        subject,
        bodyText,
        provider: providerConfig.provider,
        status: emailResult.success ? 'sent' : 'failed',
        errorMessage: emailResult.error,
        sentAt: runStartedAt,
      });

      if (emailResult.success) {
        await dependencies.dunningHistoryRepo.record(scope, {
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          daysOverdue,
          feeApplied,
          emailSent: true,
          emailLogId: emailLog.id,
          processedAt: runStartedAt,
        });

        await dependencies.auditLog.append(scope, {
          occurredAt: runStartedAt,
          action: 'invoice.dunning_reminder_sent',
          reason: `Mahnstufe ${applicableLevel.id}`,
          actor,
          subject: buildAuditSubject(scope, invoice.id),
        });

        result.emailsSent += 1;
        logger?.info?.('DunningService email sent', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
        });
      } else {
        await dependencies.dunningHistoryRepo.record(scope, {
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          daysOverdue,
          feeApplied,
          emailSent: false,
          processedAt: runStartedAt,
        });

        await dependencies.auditLog.append(scope, {
          occurredAt: runStartedAt,
          action: 'invoice.dunning_reminder_failed',
          reason: `Mahnstufe ${applicableLevel.id}: ${emailResult.error ?? 'unknown error'}`,
          actor,
          subject: buildAuditSubject(scope, invoice.id),
        });

        logger?.error?.('DunningService email failed', {
          invoiceNumber: invoice.number,
          dunningLevel: applicableLevel.id,
          error: emailResult.error,
        });
        result.errors.push({
          invoiceNumber: invoice.number,
          error: `Email failed: ${emailResult.error}`,
        });
      }

      result.processedInvoices += 1;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const retryable = dependencies.isRetryableError?.(error) ?? false;
      result.errors.push({
        invoiceNumber: invoice.number,
        error: `${errorMessage}${retryable ? ' (will retry)' : ' (permanent failure)'}`,
      });

      logger?.error?.('DunningService failed to process invoice', {
        invoiceNumber: invoice.number,
        retryable,
        error: errorMessage,
      });
    }
  }

  const nextSettings = {
    ...settings,
    automation: {
      ...settings.automation,
      lastDunningRun: runStartedAt,
    },
  };
  await dependencies.settingsRepo.save(scope, nextSettings);

  return result;
};
