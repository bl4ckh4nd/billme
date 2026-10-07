import fs from 'node:fs/promises';
import { z } from 'zod';
import { localIsoDate } from '@billme/server-core/domain';
import { createServerApiClient, createSingleTenantScope, queueEmailDelivery } from '@billme/server-core';
import {
  applyServerModeLiteTenantSeed,
  applyServerModeProTenantSeed,
  buildServerModeLiteTenantSeed,
  buildServerModeProTenantSeed,
  createPostgresEmailOutboxRepository,
  createPostgresPool,
} from '@billme/server-data';

const payloadSchema = z.object({
  stateFile: z.string().trim().min(1),
  product: z.enum(['lite', 'pro']),
  namespace: z.string().trim().min(1),
  shareToken: z.string().trim().min(16),
  queuedSubject: z.string().trim().min(1),
  smtpPort: z.coerce.number().int().positive(),
  portalBaseUrl: z.string().url(),
});

const parseEnv = (content: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    let value = rawLine.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
};

const readDatabaseUrl = async (envFilePath: string): Promise<string> => {
  const env = parseEnv(await fs.readFile(envFilePath, 'utf8'));
  const user = env.BILLME_POSTGRES_USER ?? 'billme';
  const password = env.BILLME_POSTGRES_PASSWORD ?? 'billme';
  const port = env.BILLME_POSTGRES_PORT ?? '5432';
  const database = env.BILLME_POSTGRES_DB ?? 'billme';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
};

const buildDatabaseUrl = (env: Record<string, string>): string => {
  const user = env.BILLME_POSTGRES_USER ?? 'billme';
  const password = env.BILLME_POSTGRES_PASSWORD ?? 'billme';
  const port = env.BILLME_POSTGRES_PORT ?? '5432';
  const database = env.BILLME_POSTGRES_DB ?? 'billme';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
};

const now = new Date();
const todayIso = localIsoDate(now);
const currentRunTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
const overdueDate = new Date(now);
overdueDate.setDate(overdueDate.getDate() - 10);
const overdueIso = localIsoDate(overdueDate);
const issuedDate = new Date(now);
issuedDate.setDate(issuedDate.getDate() - 24);
const issuedIso = localIsoDate(issuedDate);

const main = async () => {
  const payload = payloadSchema.parse(JSON.parse(process.argv[2] ?? '{}'));
  const state = JSON.parse(await fs.readFile(payload.stateFile, 'utf8')) as {
    env?: Record<string, string>;
    envFile: string;
    urls: {
      api: string;
    };
  };
  const databaseUrl = state.env ? buildDatabaseUrl(state.env) : await readDatabaseUrl(state.envFile);
  const ownerEmail = `${payload.product}-owner@billme-e2e.local`;
  const apiClient = createServerApiClient(state.urls.api);
  const session = await apiClient.ensureSession({
    product: payload.product,
    email: ownerEmail,
    password: 'billme-server-123',
    fullName: payload.product === 'pro' ? 'Billme Pro Owner' : 'Billme Lite Owner',
  });

  const dunningFee = 12.5;
  const queueRecipientEmail = `queue+${payload.namespace}@example.com`;
  const queueBodyText = `Queued email body for ${payload.namespace}`;
  const pool = createPostgresPool(databaseUrl);

  try {
    const scope = createSingleTenantScope(session.tenantId, payload.product);
    const seed =
      payload.product === 'pro'
        ? buildServerModeProTenantSeed({
            tenantId: session.tenantId,
            namespace: payload.namespace,
          })
        : buildServerModeLiteTenantSeed({
            tenantId: session.tenantId,
            namespace: payload.namespace,
          });

    seed.settings.automation = {
      ...seed.settings.automation,
      recurringEnabled: true,
      recurringRunTime: currentRunTime,
      dunningEnabled: true,
      dunningRunTime: currentRunTime,
    };
    seed.settings.email = {
      provider: 'smtp',
      smtpHost: '127.0.0.1',
      smtpPort: payload.smtpPort,
      smtpSecure: false,
      smtpUser: 'worker',
      fromName: `${payload.product === 'pro' ? 'Pro' : 'Lite'} Worker`,
      fromEmail: `worker+${payload.namespace}@billme-e2e.local`,
    };
    seed.settings.portal = {
      baseUrl: payload.portalBaseUrl,
    };
    seed.settings.dunning = {
      ...seed.settings.dunning,
      levels: seed.settings.dunning.levels.map((level, index) =>
        index === 0
          ? {
              ...level,
              fee: dunningFee,
            }
          : level
      ),
    };

    const overdueInvoice = seed.invoices[1]!;
    seed.invoices[1] = {
      ...overdueInvoice,
      status: 'overdue',
      date: issuedIso,
      dueDate: overdueIso,
      dunningLevel: 0,
    };

    const recurringProfile = seed.recurringProfiles[0]!;
    seed.recurringProfiles[0] = {
      ...recurringProfile,
      nextRun: todayIso,
      lastRun: undefined,
    };

    const sharedOffer = seed.offers[0]!;
    seed.offers[0] = {
      ...sharedOffer,
      status: 'open',
      share: {
        token: payload.shareToken,
        publishedAt: now.toISOString(),
      },
    };

    if (payload.product === 'pro') {
      await applyServerModeProTenantSeed(pool, seed);
    } else {
      await applyServerModeLiteTenantSeed(pool, seed);
    }

    const queuedEntry = await queueEmailDelivery(
      scope,
      {
        outboxRepo: createPostgresEmailOutboxRepository(pool),
      },
      {
        documentType: 'invoice',
        documentId: seed.invoices[0]!.id,
        documentNumber: seed.invoices[0]!.number,
        recipientEmail: queueRecipientEmail,
        recipientName: 'Queue Recipient',
        subject: payload.queuedSubject,
        bodyText: queueBodyText,
      },
    );

    process.stdout.write(
      JSON.stringify({
        databaseUrl,
        token: session.token,
        tenantId: session.tenantId,
        overdueInvoiceId: seed.invoices[1]!.id,
        overdueInvoiceNumber: seed.invoices[1]!.number,
        expectedOverdueAmount: Number(seed.invoices[1]!.amount) + dunningFee,
        recurringProfileId: seed.recurringProfiles[0]!.id,
        recurringClientId: seed.recurringProfiles[0]!.clientId,
        seedInvoiceIds: seed.invoices.map((invoice) => invoice.id),
        queuedEmailId: queuedEntry.id,
        queuedEmailDocumentId: queuedEntry.documentId,
        queuedSubject: payload.queuedSubject,
        offerId: seed.offers[0]!.id,
        expectedDunningSubject: `Zahlungserinnerung Rechnung ${seed.invoices[1]!.number}`,
        dunningFee,
        todayIso,
      }),
    );
  } finally {
    await pool.end();
  }
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
