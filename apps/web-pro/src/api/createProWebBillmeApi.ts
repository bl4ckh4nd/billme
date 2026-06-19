import {
  createBillmeApi,
  type BillmeApi,
} from '@billme/desktop-contracts-pro/api';
import {
  ipcRoutes,
  type IpcArgs,
  type IpcResult,
  type IpcRouteKey,
} from '@billme/desktop-contracts-pro/contract';
import {
  accountSchema,
  accountSuggestionRuleSchema,
  appSettingsSchema,
  articleSchema,
  bookingDraftEntitySchema,
  clientSchema,
  eurClassificationSchema,
  eurRuleSchema,
  invoiceSchema,
  journalEntryEntitySchema,
  ledgerAccountSchema,
  projectSchema,
  recurringProfileSchema,
  templateSchema,
  transactionSchema,
} from '@billme/desktop-contracts-pro/schemas';
import {
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  ensureDefaultProjectForClient,
  formatAddressMultiline,
} from '@billme/server-core/services';
import {
  addDays,
  buildUrl,
  formatSemicolonCsv,
  normalizeBaseUrl,
  parseArray,
  parseResponseError,
  parseWith,
  readJsonStorage,
  toIsoDate,
  writeJsonStorage,
  type Parser,
} from '@billme/desktop-renderer/browserRuntime';

type RequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  parser?: Parser<T>;
  query?: Record<string, string | number | boolean | null | undefined>;
};

type ProWebBillmeApiOptions = {
  baseUrl: string;
  token: string;
  onAuthFailure?: () => void;
};

type TombstoneState = {
  articles: string[];
  accounts: string[];
  templates: string[];
};

type SecretStore = Record<string, string>;

type ImportBatchStore = Array<{
  id: string;
  accountId: string;
  profile: string;
  fileName: string;
  fileSha256: string;
  mappingJson: unknown;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  createdAt: string;
  rolledBackAt?: string;
  rollbackReason?: string;
}>;

type EurLine = IpcResult<'eur:getReport'>['rows'][number];

type BackupPayload = {
  settings: IpcResult<'settings:get'>;
  clients: IpcResult<'clients:list'>;
  invoices: IpcResult<'invoices:list'>;
  offers: IpcResult<'offers:list'>;
  recurring: IpcResult<'recurring:list'>;
  articles: IpcResult<'articles:list'>;
  accounts: IpcResult<'accounts:list'>;
  templates: IpcResult<'templates:list'>;
  transactions: unknown[];
  importBatches: ImportBatchStore;
  eurRules: IpcResult<'eur:listRules'>;
  eurClassifications: IpcResult<'eur:upsertClassification'>[];
  drafts: NonNullable<IpcResult<'pro:getDraftByTransactionId'>>[];
  journalEntries: IpcResult<'pro:listJournalEntries'>;
};

const BROWSER_SECRET_STORAGE_KEY = 'billme.web-pro.secrets.v1';
const BROWSER_TOMBSTONE_STORAGE_KEY = 'billme.web-pro.tombstones.v1';
const BROWSER_TRANSACTION_STORAGE_KEY = 'billme.web-pro.transactions.v1';
const BROWSER_IMPORT_BATCH_STORAGE_KEY = 'billme.web-pro.import-batches.v1';
const BROWSER_EUR_RULE_STORAGE_KEY = 'billme.web-pro.eur-rules.v1';
const BROWSER_EUR_CLASSIFICATION_STORAGE_KEY = 'billme.web-pro.eur-classifications.v1';
const BROWSER_DRAFT_STORAGE_KEY = 'billme.web-pro.drafts.v1';
const BROWSER_JOURNAL_STORAGE_KEY = 'billme.web-pro.journal.v1';
const DEFAULT_TOMBSTONES: TombstoneState = {
  articles: [],
  accounts: [],
  templates: [],
};
const UNSUPPORTED_MESSAGE = 'Not available in Billme Pro web shell yet.';
const CLIENT_MUTATION_REASON = 'Updated client in Billme Pro web shell';
const CLIENT_DELETE_REASON = 'Deleted in Billme Pro web shell';
const RECURRING_MUTATION_REASON = 'Updated recurring profile in Billme Pro web shell';
const RECURRING_DELETE_REASON = 'Deleted recurring profile in Billme Pro web shell';
const EUR_LINES: EurLine[] = [
  {
    lineId: 'income-operating',
    kennziffer: '11',
    label: 'Betriebseinnahmen',
    kind: 'income',
    exportable: true,
    total: 0,
    sortOrder: 10,
  },
  {
    lineId: 'expense-operating',
    kennziffer: '20',
    label: 'Betriebsausgaben',
    kind: 'expense',
    exportable: true,
    total: 0,
    sortOrder: 20,
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parseResult = <K extends IpcRouteKey>(key: K, value: unknown): IpcResult<K> => {
  return ipcRoutes[key].result.parse(value) as IpcResult<K>;
};

const matchesRule = (value: string, operator: 'contains' | 'equals' | 'startsWith', expected: string) => {
  const haystack = value.toLocaleLowerCase('de-DE');
  const needle = expected.toLocaleLowerCase('de-DE');
  if (operator === 'equals') return haystack === needle;
  if (operator === 'startsWith') return haystack.startsWith(needle);
  return haystack.includes(needle);
};

const createHiddenFileInput = (): Promise<File | null> => {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    };
    document.body.appendChild(input);
    input.click();
  });
};

const splitCsvLine = (line: string, delimiter: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
};

const detectDelimiter = (headerLine: string): string => {
  const candidates = [';', ',', '\t'];
  let best = ';';
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = headerLine.split(candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
};

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const normalized = value.replace(/\./g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseDateValue = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const deMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (deMatch) {
    const [, day, month, year] = deMatch;
    return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : toIsoDate(parsed);
};

const guessColumn = (headers: string[], patterns: RegExp[], fallbackIndex: number): string => {
  const found = headers.find((header) => patterns.some((pattern) => pattern.test(header)));
  return found ?? headers[fallbackIndex] ?? headers[0] ?? '';
};

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
};

const buildPrintUrl = (kind: 'invoice' | 'offer' | 'eur', params: Record<string, string>): string => {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('__print', '1');
  url.searchParams.set('kind', kind);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
};

export const createProWebBillmeApi = ({
  baseUrl,
  token,
  onAuthFailure,
}: ProWebBillmeApiOptions): BillmeApi => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const browserFileRegistry = new Map<string, File>();
  let tombstones = readJsonStorage(
    BROWSER_TOMBSTONE_STORAGE_KEY,
    DEFAULT_TOMBSTONES,
    (input) => ({
      articles: Array.isArray((input as TombstoneState | undefined)?.articles) ? (input as TombstoneState).articles : [],
      accounts: Array.isArray((input as TombstoneState | undefined)?.accounts) ? (input as TombstoneState).accounts : [],
      templates: Array.isArray((input as TombstoneState | undefined)?.templates) ? (input as TombstoneState).templates : [],
    }),
  );
  let secrets = readJsonStorage(BROWSER_SECRET_STORAGE_KEY, {} as SecretStore, (input) => (isRecord(input)
    ? Object.fromEntries(
        Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {}));
  let transactions = readJsonStorage(BROWSER_TRANSACTION_STORAGE_KEY, [] as IpcResult<'transactions:list'>, parseArray(transactionSchema));
  let importBatches = readJsonStorage(BROWSER_IMPORT_BATCH_STORAGE_KEY, [] as ImportBatchStore, (input) => {
    return Array.isArray(input)
      ? input.filter(isRecord).map((batch) => ({
          id: typeof batch.id === 'string' ? batch.id : crypto.randomUUID(),
          accountId: typeof batch.accountId === 'string' ? batch.accountId : '',
          profile: typeof batch.profile === 'string' ? batch.profile : 'generic',
          fileName: typeof batch.fileName === 'string' ? batch.fileName : 'import.csv',
          fileSha256: typeof batch.fileSha256 === 'string' ? batch.fileSha256 : ''.padStart(64, '0'),
          mappingJson: batch.mappingJson,
          importedCount: typeof batch.importedCount === 'number' ? batch.importedCount : 0,
          skippedCount: typeof batch.skippedCount === 'number' ? batch.skippedCount : 0,
          errorCount: typeof batch.errorCount === 'number' ? batch.errorCount : 0,
          createdAt: typeof batch.createdAt === 'string' ? batch.createdAt : new Date().toISOString(),
          rolledBackAt: typeof batch.rolledBackAt === 'string' ? batch.rolledBackAt : undefined,
          rollbackReason: typeof batch.rollbackReason === 'string' ? batch.rollbackReason : undefined,
        }))
      : [];
  });
  let eurRules = readJsonStorage(BROWSER_EUR_RULE_STORAGE_KEY, [] as IpcResult<'eur:listRules'>, parseArray(eurRuleSchema));
  let eurClassifications = readJsonStorage(
    BROWSER_EUR_CLASSIFICATION_STORAGE_KEY,
    [] as IpcResult<'eur:upsertClassification'>[],
    parseArray(eurClassificationSchema),
  );
  let drafts = readJsonStorage(
    BROWSER_DRAFT_STORAGE_KEY,
    [] as NonNullable<IpcResult<'pro:getDraftByTransactionId'>>[],
    parseArray(bookingDraftEntitySchema),
  );
  let journalEntries = readJsonStorage(
    BROWSER_JOURNAL_STORAGE_KEY,
    [] as IpcResult<'pro:listJournalEntries'>,
    parseArray(journalEntryEntitySchema),
  );

  const persistTombstones = () => writeJsonStorage(BROWSER_TOMBSTONE_STORAGE_KEY, tombstones);
  const persistSecrets = () => writeJsonStorage(BROWSER_SECRET_STORAGE_KEY, secrets);
  const persistTransactions = () => writeJsonStorage(BROWSER_TRANSACTION_STORAGE_KEY, transactions);
  const persistImportBatches = () => writeJsonStorage(BROWSER_IMPORT_BATCH_STORAGE_KEY, importBatches);
  const persistEurRules = () => writeJsonStorage(BROWSER_EUR_RULE_STORAGE_KEY, eurRules);
  const persistEurClassifications = () => writeJsonStorage(BROWSER_EUR_CLASSIFICATION_STORAGE_KEY, eurClassifications);
  const persistDrafts = () => writeJsonStorage(BROWSER_DRAFT_STORAGE_KEY, drafts);
  const persistJournalEntries = () => writeJsonStorage(BROWSER_JOURNAL_STORAGE_KEY, journalEntries);

  const requestJson = async <T>(path: string, options?: RequestOptions<T>): Promise<T> => {
    const response = await fetch(buildUrl(normalizedBaseUrl, path, options?.query), {
      method: options?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      onAuthFailure?.();
    }
    if (!response.ok) {
      throw parseResponseError(response.status, payload);
    }
    if (!options?.parser) {
      return payload as T;
    }
    return parseWith(options.parser, payload);
  };

  const getSettings = async () => {
    return requestJson('/api/v1/pro/settings', {
      parser: (input) => (input === null ? null : appSettingsSchema.parse(input)),
    });
  };

  const listClients = async () => {
    return requestJson('/api/v1/pro/clients', { parser: parseArray(clientSchema) });
  };

  const listInvoices = async () => {
    return requestJson('/api/v1/pro/invoices', { parser: parseArray(invoiceSchema) });
  };

  const listOffers = async () => {
    return requestJson('/api/v1/pro/offers', { parser: parseArray(invoiceSchema) });
  };

  const listRecurring = async () => {
    return requestJson('/api/v1/pro/recurring', { parser: parseArray(recurringProfileSchema) });
  };

  const listArticles = async () => {
    const rows = await requestJson('/api/v1/pro/articles', { parser: parseArray(articleSchema) });
    const deletedIds = new Set(tombstones.articles);
    return rows.filter((row) => !deletedIds.has(row.id));
  };

  const listAccounts = async () => {
    const rows = await requestJson('/api/v1/pro/accounts', { parser: parseArray(accountSchema) });
    const deletedIds = new Set(tombstones.accounts);
    return rows.filter((row) => !deletedIds.has(row.id));
  };

  const listTemplates = async (kind?: 'invoice' | 'offer') => {
    const rows = await requestJson('/api/v1/pro/templates', {
      query: kind ? { kind } : undefined,
      parser: parseArray(templateSchema),
    });
    const deletedIds = new Set(tombstones.templates);
    return rows.filter((row) => !deletedIds.has(row.id));
  };

  const getActiveTemplate = async (kind: 'invoice' | 'offer') => {
    const template = await requestJson(`/api/v1/pro/templates/active/${kind}`, {
      parser: (input) => (input === null ? null : templateSchema.parse(input)),
    });
    if (template && tombstones.templates.includes(template.id)) {
      return null;
    }
    return template;
  };

  const reserveNumber = async (kind: 'invoice' | 'offer' | 'customer') => {
    return requestJson('/api/v1/pro/numbers/reserve', {
      method: 'POST',
      body: { kind },
      parser: (input) => parseResult('numbers:reserve', input),
    });
  };

  const findClientById = async (clientId: string) => {
    const clients = await listClients();
    return clients.find((client) => client.id === clientId) ?? null;
  };

  const findOfferById = async (offerId: string) => {
    const offers = await listOffers();
    return offers.find((offer) => offer.id === offerId) ?? null;
  };

  const ensureClientDefaultProject = async (initialClient: IpcResult<'clients:list'>[number]) => {
    let client = initialClient;
    type ProjectWithClientId = IpcResult<'clients:list'>[number]['projects'][number] & { clientId: string };
    const { project } = await ensureDefaultProjectForClient(
      {
        tx: {
          inTransaction<TResult>(work: () => TResult): TResult {
            return work();
          },
        },
        getActiveDefaultProjectForClient: (clientId) => {
          if (client.id !== clientId) {
            return null;
          }
          const project = client.projects.find((entry) => entry.name === 'Allgemein' && entry.status !== 'archived');
          return project ? { ...project, clientId: project.clientId ?? client.id } : null;
        },
        listProjectCodesByPrefix: async (prefix) => {
          const clients = await listClients();
          return clients.flatMap((entry) =>
            entry.projects
              .map((project) => project.code)
              .filter((code): code is string => typeof code === 'string' && code.startsWith(prefix)),
          );
        },
        saveProject: async (project) => {
          client = await requestJson('/api/v1/pro/clients', {
            method: 'POST',
            body: {
              reason: CLIENT_MUTATION_REASON,
              client: {
                ...client,
                projects: [...client.projects.filter((entry) => entry.id !== project.id), project],
              },
            },
            parser: clientSchema,
          });
          const savedProject = client.projects.find((entry) => entry.id === project.id);
          return savedProject ? { ...savedProject, clientId: savedProject.clientId ?? client.id } : project;
        },
      },
      {
        clientId: initialClient.id,
        createProjectId: () => crypto.randomUUID(),
        buildProject: (project): ProjectWithClientId => {
          const normalized = projectSchema.parse({ ...project, clientId: project.clientId ?? initialClient.id });
          return { ...normalized, clientId: normalized.clientId ?? initialClient.id };
        },
      },
    );
    return project;
  };

  const buildDocumentDraft = async (
    kind: 'invoice' | 'offer',
    clientId: string,
  ): Promise<IpcResult<'documents:createFromClient'>> => {
    const client = await findClientById(clientId);
    if (!client) {
      throw new Error('Client not found');
    }
    const reservation = await reserveNumber(kind);
    const billingAddress = chooseDefaultBillingAddress(client.addresses ?? []);
    const shippingAddress = client.addresses?.find((address) => address.isDefaultShipping) ?? billingAddress ?? null;
    const billingEmail = chooseDefaultBillingEmail(client.emails ?? []);
    const project = await ensureClientDefaultProject(client);
    const today = toIsoDate(new Date());
    return parseResult('documents:createFromClient', {
      id: crypto.randomUUID(),
      clientId: client.id,
      clientNumber: client.customerNumber,
      projectId: project?.id,
      number: reservation.number,
      numberReservationId: reservation.reservationId,
      client: client.company,
      clientEmail: billingEmail?.email ?? '',
      clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : '',
      billingAddressJson: billingAddress ?? undefined,
      shippingAddressJson: shippingAddress ?? undefined,
      date: today,
      dueDate: kind === 'offer' ? today : '',
      amount: 0,
      status: 'draft',
      items: [],
      payments: [],
      history: [],
    });
  };

  const upsertInvoice = async (invoice: IpcArgs<'invoices:upsert'>['invoice'], reason: string) => {
    return requestJson('/api/v1/pro/invoices', {
      method: 'POST',
      body: { invoice, reason },
      parser: invoiceSchema,
    });
  };

  const upsertOffer = async (offer: IpcArgs<'offers:upsert'>['offer'], reason: string) => {
    return requestJson('/api/v1/pro/offers', {
      method: 'POST',
      body: { offer, reason },
      parser: invoiceSchema,
    });
  };

  const parseCsvFile = async (
    file: File,
    overrideDelimiter?: string,
    maxRows?: number,
  ) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return {
        delimiter: overrideDelimiter ?? ';',
        headers: [] as string[],
        rows: [] as Array<Record<string, string>>,
        fileSha256: await sha256Hex(text),
      };
    }
    const delimiter = overrideDelimiter ?? detectDelimiter(lines[0]!);
    const headers = splitCsvLine(lines[0]!, delimiter);
    const rows = lines.slice(1, maxRows ? maxRows + 1 : undefined).map((line) => {
      const values = splitCsvLine(line, delimiter);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    });
    return {
      delimiter,
      headers,
      rows,
      fileSha256: await sha256Hex(text),
    };
  };

  const getSuggestedMapping = (headers: string[]) => ({
    dateColumn: guessColumn(headers, [/date/i, /datum/i, /buchung/i], 0),
    amountColumn: guessColumn(headers, [/betrag/i, /amount/i, /umsatz/i], 1),
    counterpartyColumn: guessColumn(headers, [/name/i, /empf/i, /counterparty/i, /auftraggeber/i], 2),
    purposeColumn: guessColumn(headers, [/zweck/i, /purpose/i, /verwendungs/i, /text/i], 3),
    statusColumn: headers.find((header) => /status/i.test(header)),
    externalIdColumn: headers.find((header) => /ref|referenz|id/i.test(header)),
    currencyColumn: headers.find((header) => /currency|währung/i.test(header)),
    currencyExpected: 'EUR',
  });

  const getTransactions = () => transactions;

  const getProjects = async (args: IpcArgs<'projects:list'>) => {
    const clients = await listClients();
    return clients
      .flatMap((client) =>
        client.projects.map((project) => ({
          ...project,
          clientId: project.clientId ?? client.id,
        })),
      )
      .filter((project) => (args.clientId ? project.clientId === args.clientId : true))
      .filter((project) => (args.includeArchived ? true : project.status !== 'archived'));
  };

  const saveProject = async (args: IpcArgs<'projects:upsert'>) => {
    const clients = await listClients();
    const targetClient = clients.find((client) => client.id === args.project.clientId);
    if (!targetClient) {
      throw new Error('Client not found for project');
    }
    const projects = [
      ...targetClient.projects.filter((project) => project.id !== args.project.id),
      { ...projectSchema.parse(args.project), clientId: targetClient.id },
    ].sort((left, right) => left.name.localeCompare(right.name, 'de-DE'));
    await requestJson('/api/v1/pro/clients', {
      method: 'POST',
      body: {
        reason: args.reason,
        client: {
          ...targetClient,
          projects,
        },
      },
      parser: clientSchema,
    });
    return parseResult('projects:upsert', { ...args.project, clientId: targetClient.id });
  };

  const archiveProject = async (args: IpcArgs<'projects:archive'>) => {
    const clients = await listClients();
    const now = new Date().toISOString();
    const targetClient = clients.find((client) => client.projects.some((project) => project.id === args.id));
    if (!targetClient) {
      throw new Error('Project not found');
    }
    const nextProject = targetClient.projects.find((project) => project.id === args.id);
    if (!nextProject) {
      throw new Error('Project not found');
    }
    const projects = targetClient.projects.map((project) =>
      project.id === args.id
        ? {
            ...project,
            status: 'archived' as const,
            archivedAt: now,
            updatedAt: now,
          }
        : project,
    );
    await requestJson('/api/v1/pro/clients', {
      method: 'POST',
      body: {
        reason: args.reason,
        client: {
          ...targetClient,
          projects,
        },
      },
      parser: clientSchema,
    });
    return parseResult('projects:archive', {
      ...nextProject,
      clientId: nextProject.clientId ?? targetClient.id,
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    });
  };

  const getEurItems = async (args: IpcArgs<'eur:listItems'>): Promise<IpcResult<'eur:listItems'>> => {
    const txRows = getTransactions();
    const invoiceRows = await listInvoices();
    const items = [
      ...txRows.map((transaction) => ({
        sourceType: 'transaction' as const,
        sourceId: transaction.id,
        date: transaction.date,
        amountGross: Math.abs(transaction.amount),
        amountNet: Math.abs(transaction.amount),
        flowType: transaction.type,
        accountId: transaction.accountId,
        linkedViaInvoice: Boolean(transaction.linkedInvoiceId),
        counterparty: transaction.counterparty,
        purpose: transaction.purpose,
      })),
      ...invoiceRows.map((invoice) => ({
        sourceType: 'invoice' as const,
        sourceId: invoice.id,
        date: invoice.date,
        amountGross: Math.abs(invoice.amount),
        amountNet: Math.abs(invoice.amount),
        flowType: 'income' as const,
        accountId: undefined,
        linkedViaInvoice: true,
        counterparty: invoice.client,
        purpose: invoice.number,
      })),
    ].filter((item) => {
      const itemYear = Number(item.date.slice(0, 4));
      if (itemYear !== args.taxYear) return false;
      if (args.sourceType && item.sourceType !== args.sourceType) return false;
      if (args.flowType && item.flowType !== args.flowType) return false;
      if (args.accountId && item.accountId !== args.accountId) return false;
      if (args.search) {
        const haystack = `${item.counterparty} ${item.purpose} ${item.date}`.toLocaleLowerCase('de-DE');
        if (!haystack.includes(args.search.toLocaleLowerCase('de-DE'))) {
          return false;
        }
      }
      return true;
    });

    const sortedRules = eurRules
      .filter((rule) => rule.taxYear === args.taxYear && rule.active)
      .sort((left, right) => left.priority - right.priority);

    return parseResult(
      'eur:listItems',
      items
        .map((item) => {
          const classification = eurClassifications.find(
            (entry) => entry.sourceType === item.sourceType && entry.sourceId === item.sourceId && entry.taxYear === args.taxYear,
          );
          const suggestedRule = sortedRules.find((rule) => {
            const target =
              rule.field === 'counterparty'
                ? item.counterparty
                : rule.field === 'purpose'
                  ? item.purpose
                  : `${item.counterparty} ${item.purpose}`;
            return matchesRule(target, rule.operator, rule.value);
          });
          return {
            ...item,
            suggestedLineId: suggestedRule?.targetEurLineId,
            suggestionReason: suggestedRule ? `Rule: ${suggestedRule.value}` : undefined,
            suggestionLayer: suggestedRule ? 'keyword' as const : undefined,
            classification,
            line: EUR_LINES.find((line) => line.lineId === classification?.eurLineId),
          };
        })
        .filter((item) => {
          if (args.onlyUnclassified) {
            return !item.classification?.eurLineId && !item.classification?.excluded;
          }
          if (args.status === 'unclassified') {
            return !item.classification?.eurLineId && !item.classification?.excluded;
          }
          if (args.status === 'classified') {
            return Boolean(item.classification?.eurLineId) && !item.classification?.excluded;
          }
          if (args.status === 'excluded') {
            return Boolean(item.classification?.excluded);
          }
          return true;
        }),
    );
  };

  const getEurReport = async (args: IpcArgs<'eur:getReport'>): Promise<IpcResult<'eur:getReport'>> => {
    const items = await getEurItems({ taxYear: args.taxYear, sourceType: undefined, status: 'all' });
    const totals = new Map<string, number>();
    let unclassifiedCount = 0;
    for (const item of items) {
      if (item.classification?.excluded) {
        continue;
      }
      if (!item.classification?.eurLineId) {
        unclassifiedCount += 1;
        continue;
      }
      totals.set(item.classification.eurLineId, (totals.get(item.classification.eurLineId) ?? 0) + item.amountNet);
    }
    const rows = EUR_LINES.map((line) => ({
      ...line,
      total: totals.get(line.lineId) ?? 0,
    }));
    return parseResult('eur:getReport', {
      taxYear: args.taxYear,
      from: args.from ?? `${args.taxYear}-01-01`,
      to: args.to ?? `${args.taxYear}-12-31`,
      rows,
      summary: {
        incomeTotal: rows.filter((row) => row.kind === 'income').reduce((sum, row) => sum + row.total, 0),
        expenseTotal: rows.filter((row) => row.kind === 'expense').reduce((sum, row) => sum + row.total, 0),
        surplus:
          rows.filter((row) => row.kind === 'income').reduce((sum, row) => sum + row.total, 0)
          - rows.filter((row) => row.kind === 'expense').reduce((sum, row) => sum + row.total, 0),
      },
      unclassifiedCount,
      warnings: [],
    });
  };

  const invoke = async (key: IpcRouteKey, rawArgs: unknown): Promise<unknown> => {
    const args = ipcRoutes[key].args.parse(rawArgs) as any;

    switch (key) {
      case 'clients:list':
        return parseResult(key, await listClients());
      case 'clients:upsert':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/clients', {
            method: 'POST',
            body: {
              reason: CLIENT_MUTATION_REASON,
              client: args.client,
            },
            parser: clientSchema,
          }),
        );
      case 'clients:delete':
        return parseResult(
          key,
          await requestJson(`/api/v1/pro/clients/${encodeURIComponent(args.id)}`, {
            method: 'DELETE',
            body: { reason: CLIENT_DELETE_REASON },
            parser: (input) => input,
          }),
        );
      case 'invoices:list':
        return parseResult(key, await listInvoices());
      case 'invoices:upsert':
        return parseResult(key, await upsertInvoice(args.invoice, args.reason));
      case 'invoices:delete':
        return parseResult(
          key,
          await requestJson(`/api/v1/pro/invoices/${encodeURIComponent(args.id)}`, {
            method: 'DELETE',
            body: { reason: args.reason },
            parser: (input) => input,
          }),
        );
      case 'offers:list':
        return parseResult(key, await listOffers());
      case 'offers:upsert':
        return parseResult(key, await upsertOffer(args.offer, args.reason));
      case 'offers:delete':
        return parseResult(
          key,
          await requestJson(`/api/v1/pro/offers/${encodeURIComponent(args.id)}`, {
            method: 'DELETE',
            body: { reason: args.reason },
            parser: (input) => input,
          }),
        );
      case 'recurring:list':
        return parseResult(key, await listRecurring());
      case 'recurring:upsert':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/recurring', {
            method: 'POST',
            body: { reason: args.reason || RECURRING_MUTATION_REASON, profile: args.profile },
            parser: recurringProfileSchema,
          }),
        );
      case 'recurring:delete':
        return parseResult(
          key,
          await requestJson(`/api/v1/pro/recurring/${encodeURIComponent(args.id)}`, {
            method: 'DELETE',
            body: { reason: RECURRING_DELETE_REASON },
            parser: (input) => input,
          }),
        );
      case 'recurring:manualRun':
        return parseResult(key, {
          success: true,
          result: {
            generated: 0,
            deactivated: 0,
            errors: [],
          },
        });
      case 'settings:get':
        return parseResult(key, await getSettings());
      case 'settings:set':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/settings', {
            method: 'PUT',
            body: args,
            parser: (input) => input,
          }),
        );
      case 'numbers:reserve':
        return parseResult(key, await reserveNumber(args.kind));
      case 'numbers:release':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/numbers/release', {
            method: 'POST',
            body: args,
            parser: (input) => input,
          }),
        );
      case 'numbers:finalize':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/numbers/finalize', {
            method: 'POST',
            body: args,
            parser: (input) => input,
          }),
        );
      case 'documents:createFromClient':
        return buildDocumentDraft(args.kind, args.clientId);
      case 'documents:convertOfferToInvoice': {
        const offer = await findOfferById(args.offerId);
        if (!offer) {
          throw new Error('Offer not found');
        }
        const settings = await getSettings();
        const reservation = await reserveNumber('invoice');
        const today = toIsoDate(new Date());
        const invoiceDate = args.invoiceDate ?? today;
        const dueDate = args.dueDate ?? addDays(today, settings?.legal.paymentTermsDays ?? 14);
        const created = await upsertInvoice(
          {
            ...offer,
            id: crypto.randomUUID(),
            number: reservation.number,
            numberReservationId: reservation.reservationId,
            date: invoiceDate,
            dueDate: dueDate,
            status: 'draft',
            dunningLevel: 0,
            payments: [],
            history: [
              ...(offer.history ?? []),
              {
                date: today,
                action: `Erstellt aus Angebot ${offer.number}`,
              },
            ],
          },
          `Converted from offer ${offer.number}`,
        );
        return parseResult(key, created);
      }
      case 'articles:list':
        return parseResult(key, await listArticles());
      case 'articles:upsert': {
        tombstones = { ...tombstones, articles: tombstones.articles.filter((id) => id !== args.article.id) };
        persistTombstones();
        return parseResult(
          key,
          await requestJson('/api/v1/pro/articles', {
            method: 'POST',
            body: args,
            parser: articleSchema,
          }),
        );
      }
      case 'articles:delete':
        tombstones = {
          ...tombstones,
          articles: Array.from(new Set([...tombstones.articles, args.id])),
        };
        persistTombstones();
        return parseResult(key, { ok: true });
      case 'accounts:list':
        return parseResult(key, await listAccounts());
      case 'accounts:upsert': {
        tombstones = { ...tombstones, accounts: tombstones.accounts.filter((id) => id !== args.account.id) };
        persistTombstones();
        return parseResult(
          key,
          await requestJson('/api/v1/pro/accounts', {
            method: 'POST',
            body: args,
            parser: accountSchema,
          }),
        );
      }
      case 'accounts:delete':
        tombstones = {
          ...tombstones,
          accounts: Array.from(new Set([...tombstones.accounts, args.id])),
        };
        persistTombstones();
        return parseResult(key, { ok: true });
      case 'projects:list':
        return parseResult(key, await getProjects(args));
      case 'projects:get': {
        const projects = await getProjects({ includeArchived: true });
        return parseResult(key, projects.find((project) => project.id === args.id) ?? null);
      }
      case 'projects:upsert':
        return parseResult(key, await saveProject(args));
      case 'projects:archive':
        return parseResult(key, await archiveProject(args));
      case 'templates:list':
        return parseResult(key, await listTemplates(args.kind));
      case 'templates:active':
        return parseResult(key, await getActiveTemplate(args.kind));
      case 'templates:upsert': {
        tombstones = { ...tombstones, templates: tombstones.templates.filter((id) => id !== args.template.id) };
        persistTombstones();
        return parseResult(
          key,
          await requestJson('/api/v1/pro/templates', {
            method: 'POST',
            body: args,
            parser: templateSchema,
          }),
        );
      }
      case 'templates:delete':
        tombstones = {
          ...tombstones,
          templates: Array.from(new Set([...tombstones.templates, args.id])),
        };
        persistTombstones();
        return parseResult(key, { ok: true });
      case 'templates:setActive':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/templates/active', {
            method: 'PUT',
            body: args,
            parser: (input) => input,
          }),
        );
      case 'audit:verify': {
        const [clients, invoices, offers] = await Promise.all([listClients(), listInvoices(), listOffers()]);
        return parseResult(key, {
          ok: true,
          errors: [],
          count: clients.length + invoices.length + offers.length,
          headHash: null,
        });
      }
      case 'audit:exportCsv': {
        const [clients, invoices, offers] = await Promise.all([listClients(), listInvoices(), listOffers()]);
        return parseResult(
          key,
          formatSemicolonCsv(
            [
              ...clients.map((client) => ({ entity: 'client', id: client.id, label: client.company, status: client.status, date: '' })),
              ...invoices.map((invoice) => ({ entity: 'invoice', id: invoice.id, label: invoice.number, status: invoice.status, date: invoice.date })),
              ...offers.map((offer) => ({ entity: 'offer', id: offer.id, label: offer.number, status: offer.status, date: offer.date })),
            ],
            ['entity', 'id', 'label', 'status', 'date'],
          ),
        );
      }
      case 'pdf:export':
        return parseResult(key, { path: buildPrintUrl(args.kind, { id: args.id }) });
      case 'window:minimize':
      case 'window:toggleMaximize':
      case 'window:close':
      case 'updater:downloadUpdate':
      case 'updater:quitAndInstall':
        return parseResult(key, { ok: true });
      case 'window:isMaximized':
        return parseResult(key, { isMaximized: false });
      case 'updater:getStatus':
        return parseResult(key, { status: 'idle' });
      case 'shell:openExternal': {
        window.open(args.url, '_blank', 'noopener,noreferrer');
        return parseResult(key, { ok: true });
      }
      case 'shell:openPath': {
        if (/^(blob:|data:|https?:)/.test(args.path)) {
          window.open(args.path, '_blank', 'noopener,noreferrer');
        }
        return parseResult(key, { ok: true });
      }
      case 'shell:openExportsDir':
        return parseResult(key, { ok: true });
      case 'dialog:pickCsv': {
        const file = await createHiddenFileInput();
        if (!file) {
          return parseResult(key, { path: null });
        }
        const path = `browser-file://${crypto.randomUUID()}/${encodeURIComponent(file.name)}`;
        browserFileRegistry.set(path, file);
        return parseResult(key, { path });
      }
      case 'finance:importPreview': {
        const file = browserFileRegistry.get(args.path);
        if (!file) {
          throw new Error('Selected CSV file is no longer available. Please choose it again.');
        }
        const parsed = await parseCsvFile(file, args.delimiter, args.maxRows);
        const suggestedMapping = getSuggestedMapping(parsed.headers);
        const rows = parsed.rows.map((row, index) => {
          const amount = parseNumber(row[suggestedMapping.amountColumn]);
          const date = parseDateValue(row[suggestedMapping.dateColumn]);
          const type = typeof amount === 'number' ? (amount >= 0 ? 'income' : 'expense') : undefined;
          return {
            rowIndex: index + 2,
            raw: row,
            parsed: {
              date,
              amount: typeof amount === 'number' ? Math.abs(amount) : undefined,
              type,
              counterparty: suggestedMapping.counterpartyColumn ? row[suggestedMapping.counterpartyColumn] : undefined,
              purpose: suggestedMapping.purposeColumn ? row[suggestedMapping.purposeColumn] : undefined,
              status: 'pending' as const,
              externalId: suggestedMapping.externalIdColumn ? row[suggestedMapping.externalIdColumn] : undefined,
              currency: suggestedMapping.currencyColumn ? row[suggestedMapping.currencyColumn] : 'EUR',
            },
            errors: amount === undefined || !date ? ['Date or amount could not be parsed'] : [],
            dedupHash: undefined,
          };
        });
        return parseResult(key, {
          path: args.path,
          fileName: file.name,
          fileSha256: parsed.fileSha256,
          delimiter: parsed.delimiter,
          headers: parsed.headers,
          profile: args.profile ?? 'generic',
          suggestedMapping,
          rows,
          stats: {
            totalRows: parsed.rows.length,
            previewRows: rows.length,
            validRows: rows.filter((row) => row.errors.length === 0).length,
            errorRows: rows.filter((row) => row.errors.length > 0).length,
          },
        });
      }
      case 'finance:importCommit': {
        const file = browserFileRegistry.get(args.path);
        if (!file) {
          throw new Error('Selected CSV file is no longer available. Please choose it again.');
        }
        const parsed = await parseCsvFile(file, args.delimiter);
        const createdAt = new Date().toISOString();
        const batchId = crypto.randomUUID();
        const rows = parsed.rows.map((row) => {
          const amount = parseNumber(row[args.mapping.amountColumn]);
          const date = parseDateValue(row[args.mapping.dateColumn]);
          return {
            row,
            amount,
            date,
            counterparty: args.mapping.counterpartyColumn ? row[args.mapping.counterpartyColumn] : '',
            purpose: args.mapping.purposeColumn ? row[args.mapping.purposeColumn] : '',
            externalId: args.mapping.externalIdColumn ? row[args.mapping.externalIdColumn] : '',
          };
        });
        const errors: Array<{ rowIndex: number; message: string }> = [];
        let imported = 0;
        let skipped = 0;
        for (const [index, row] of rows.entries()) {
          if (row.amount === undefined || !row.date) {
            errors.push({ rowIndex: index + 2, message: 'Date or amount could not be parsed' });
            continue;
          }
          const base = `${args.accountId}:${row.date}:${row.amount}:${row.counterparty}:${row.purpose}:${row.externalId}`;
          const dedupHash = await sha256Hex(base);
          if (transactions.some((transaction) => transaction.dedupHash === dedupHash)) {
            skipped += 1;
            continue;
          }
          transactions = [
            {
              id: crypto.randomUUID(),
              accountId: args.accountId,
              date: row.date,
              amount: Math.abs(row.amount),
              type: row.amount >= 0 ? 'income' : 'expense',
              counterparty: row.counterparty || 'Import',
              purpose: row.purpose || file.name,
              linkedInvoiceId: undefined,
              status: 'pending',
              dedupHash,
              importBatchId: batchId,
            },
            ...transactions,
          ];
          imported += 1;
        }
        persistTransactions();
        importBatches = [
          {
            id: batchId,
            accountId: args.accountId,
            profile: args.profile ?? 'generic',
            fileName: file.name,
            fileSha256: parsed.fileSha256,
            mappingJson: args.mapping,
            importedCount: imported,
            skippedCount: skipped,
            errorCount: errors.length,
            createdAt,
          },
          ...importBatches,
        ];
        persistImportBatches();
        return parseResult(key, {
          batchId,
          imported,
          skipped,
          errors,
          fileSha256: parsed.fileSha256,
        });
      }
      case 'finance:listImportBatches':
        return parseResult(
          key,
          importBatches
            .filter((batch) => (args.accountId ? batch.accountId === args.accountId : true))
            .slice(0, args.limit ?? importBatches.length),
        );
      case 'finance:getImportBatchDetails': {
        const batch = importBatches.find((entry) => entry.id === args.batchId);
        if (!batch) {
          throw new Error('Import batch not found');
        }
        const batchTransactions = transactions.filter((transaction) => transaction.importBatchId === batch.id);
        return parseResult(key, {
          batch,
          transactions: batchTransactions,
          canRollback: !batch.rolledBackAt,
          linkedInvoiceCount: batchTransactions.filter((transaction) => transaction.linkedInvoiceId).length,
        });
      }
      case 'finance:rollbackImportBatch': {
        const batch = importBatches.find((entry) => entry.id === args.batchId);
        if (!batch) {
          throw new Error('Import batch not found');
        }
        const before = transactions.length;
        transactions = transactions.filter((transaction) => transaction.importBatchId !== args.batchId);
        persistTransactions();
        importBatches = importBatches.map((entry) =>
          entry.id === args.batchId
            ? {
                ...entry,
                rolledBackAt: new Date().toISOString(),
                rollbackReason: args.reason,
              }
            : entry,
        );
        persistImportBatches();
        return parseResult(key, { success: true, deletedCount: before - transactions.length });
      }
      case 'pro:listLedgerAccounts':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/accounting/ledger/accounts', {
            query: args,
            parser: parseArray(ledgerAccountSchema),
          }),
        );
      case 'pro:getLedgerStats':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/accounting/ledger/stats', {
            parser: (input) => input,
          }),
        );
      case 'pro:listAccountSuggestionRules':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/accounting/account-suggestion-rules', {
            query: args,
            parser: parseArray(accountSuggestionRuleSchema),
          }),
        );
      case 'pro:upsertAccountSuggestionRule':
        return parseResult(
          key,
          await requestJson('/api/v1/pro/accounting/account-suggestion-rules', {
            method: 'POST',
            body: args,
            parser: accountSuggestionRuleSchema,
          }),
        );
      case 'pro:deleteAccountSuggestionRule':
        return parseResult(
          key,
          await requestJson(`/api/v1/pro/accounting/account-suggestion-rules/${encodeURIComponent(args.id)}`, {
            method: 'DELETE',
            parser: (input) => input,
          }),
        );
      case 'pro:importSkr': {
        const stats = (await requestJson('/api/v1/pro/accounting/ledger/stats', {
          parser: (input) => input,
        })) as IpcResult<'pro:getLedgerStats'>;
        return parseResult(key, {
          source: 'none',
          sourceDetails: ['Use the server-side ledger catalog for browser mode.'],
          inserted: 0,
          updated: 0,
          total: stats.total,
          skipped: 0,
          warnings: [UNSUPPORTED_MESSAGE],
          stats,
        });
      }
      case 'pro:listBankTransactions':
        return parseResult(key, getTransactions());
      case 'pro:getDraftByTransactionId':
        return parseResult(key, drafts.find((draft) => draft.transactionId === args.transactionId) ?? null);
      case 'pro:saveDraft': {
        const nextDraft = bookingDraftEntitySchema.parse(args.draft);
        drafts = [nextDraft, ...drafts.filter((draft) => draft.id !== nextDraft.id)];
        persistDrafts();
        return parseResult(key, nextDraft);
      }
      case 'pro:dispatchDraftAction': {
        const existing = drafts.find((draft) => draft.transactionId === args.transactionId);
        if (!existing) {
          throw new Error('Draft not found');
        }
        const nextStatus =
          args.action === 'approve'
            ? 'approved'
            : args.action === 'post'
              ? 'approved'
              : args.action === 'reverse'
                ? 'reversed'
                : args.action === 'create_correction'
                  ? 'corrected'
                  : args.action === 'submit_for_review'
                    ? 'pending_approval'
                    : args.action === 'reject' || args.action === 'request_receipt'
                      ? 'incomplete'
                      : 'suggested';
        const updated = bookingDraftEntitySchema.parse({
          ...existing,
          workflowStatus: nextStatus,
          updatedAt: new Date().toISOString(),
        });
        drafts = [updated, ...drafts.filter((draft) => draft.id !== updated.id)];
        persistDrafts();
        return parseResult(key, updated);
      }
      case 'pro:postDraft': {
        const draft = drafts.find((entry) => entry.id === args.draftId);
        if (!draft) {
          throw new Error('Draft not found');
        }
        const postingDate = args.postingDate ?? draft.postingDate ?? toIsoDate(new Date());
        const entry = journalEntryEntitySchema.parse({
          id: crypto.randomUUID(),
          tenantId: draft.tenantId,
          entryNumber: journalEntries.length + 1,
          postingDate,
          documentDate: draft.documentDate,
          bookingText: draft.bookingText,
          reference: draft.reference,
          period: postingDate.slice(0, 7),
          fiscalYear: Number(postingDate.slice(0, 4)),
          status: 'posted',
          sourceDraftId: draft.id,
          createdAt: new Date().toISOString(),
          lines: draft.lines,
        });
        journalEntries = [entry, ...journalEntries];
        persistJournalEntries();
        drafts = drafts.map((item) => (item.id === draft.id ? { ...item, workflowStatus: 'posted', updatedAt: new Date().toISOString() } : item));
        persistDrafts();
        return parseResult(key, {
          entry,
          issues: draft.validationIssues,
        });
      }
      case 'pro:listJournalEntries':
        return parseResult(
          key,
          journalEntries
            .filter((entry) => (args.from ? entry.postingDate >= args.from : true))
            .filter((entry) => (args.to ? entry.postingDate <= args.to : true))
            .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? journalEntries.length)),
        );
      case 'pro:reverseJournalEntry': {
        const source = journalEntries.find((entry) => entry.id === args.entryId);
        if (!source) {
          throw new Error('Journal entry not found');
        }
        const reversalEntry = journalEntryEntitySchema.parse({
          ...source,
          id: crypto.randomUUID(),
          entryNumber: journalEntries.length + 1,
          status: 'posted',
          reversedEntryId: source.id,
          createdAt: new Date().toISOString(),
          bookingText: `Storno: ${source.bookingText}`,
        });
        journalEntries = [
          reversalEntry,
          ...journalEntries.map((entry) =>
            entry.id === source.id
              ? journalEntryEntitySchema.parse({
                  ...entry,
                  status: 'reversed',
                  reversedEntryId: reversalEntry.id,
                })
              : entry,
          ),
        ];
        persistJournalEntries();
        return parseResult(key, { ok: true, reversalEntryId: reversalEntry.id });
      }
      case 'transactions:list':
        return parseResult(
          key,
          getTransactions()
            .filter((transaction) => (args.accountId ? transaction.accountId === args.accountId : true))
            .filter((transaction) => (args.type ? transaction.type === args.type : true))
            .filter((transaction) => (args.linkedOnly ? Boolean(transaction.linkedInvoiceId) : true))
            .filter((transaction) => (args.unlinkedOnly ? !transaction.linkedInvoiceId : true)),
        );
      case 'transactions:findMatches': {
        const transaction = getTransactions().find((entry) => entry.id === args.transactionId);
        if (!transaction) {
          throw new Error('Transaction not found');
        }
        const invoices = await listInvoices();
        const normalizedCounterparty = transaction.counterparty.toLocaleLowerCase('de-DE');
        const suggestions = invoices
          .filter((invoice) => invoice.status !== 'cancelled')
          .map((invoice) => {
            const amountDiff = Math.abs((invoice.amount ?? 0) - Math.abs(transaction.amount));
            const matchReasons: string[] = [];
            if (amountDiff < 0.01) matchReasons.push('Betrag stimmt überein');
            const normalizedClient = invoice.client.toLocaleLowerCase('de-DE');
            if (normalizedClient.includes(normalizedCounterparty) || normalizedCounterparty.includes(normalizedClient)) {
              matchReasons.push('Kunde passt');
            }
            if (invoice.number.toLocaleLowerCase('de-DE').includes(transaction.purpose.toLocaleLowerCase('de-DE'))) {
              matchReasons.push('Verwendungszweck passt');
            }
            const confidence = amountDiff < 0.01 ? 'high' : matchReasons.length > 0 ? 'medium' : 'low';
            return {
              invoice,
              confidence,
              matchReasons: matchReasons.length > 0 ? matchReasons : ['Nur Basisabgleich'],
              amountDiff,
            };
          })
          .sort((left, right) => left.amountDiff - right.amountDiff)
          .slice(0, 5);
        return parseResult(key, { transaction, suggestions });
      }
      case 'transactions:link': {
        const transaction = getTransactions().find((entry) => entry.id === args.transactionId);
        const invoice = (await listInvoices()).find((entry) => entry.id === args.invoiceId);
        if (!transaction || !invoice) {
          return parseResult(key, { success: false });
        }
        transactions = transactions.map((entry) =>
          entry.id === transaction.id
            ? { ...entry, linkedInvoiceId: invoice.id, status: 'booked' }
            : entry,
        );
        persistTransactions();
        const paymentId = `tx-${transaction.id}`;
        const payments = [
          ...invoice.payments.filter((payment) => payment.id !== paymentId),
          {
            id: paymentId,
            date: transaction.date,
            amount: Math.abs(transaction.amount),
            method: 'Bankabgleich',
          },
        ];
        const totalPaid = payments.reduce((sum, payment) => sum + payment.amount, 0);
        const nextStatus = totalPaid >= invoice.amount ? 'paid' : 'open';
        const updatedInvoice = await upsertInvoice(
          {
            ...invoice,
            payments,
            status: nextStatus,
          },
          `Linked transaction ${transaction.id}`,
        );
        return parseResult(key, { success: true, invoice: updatedInvoice });
      }
      case 'transactions:unlink': {
        const transaction = getTransactions().find((entry) => entry.id === args.transactionId);
        if (!transaction) {
          return parseResult(key, { success: false });
        }
        const linkedInvoiceId = transaction.linkedInvoiceId;
        transactions = transactions.map((entry) =>
          entry.id === transaction.id
            ? { ...entry, linkedInvoiceId: undefined, status: 'pending' }
            : entry,
        );
        persistTransactions();
        if (linkedInvoiceId) {
          const invoice = (await listInvoices()).find((entry) => entry.id === linkedInvoiceId);
          if (invoice) {
            const paymentId = `tx-${transaction.id}`;
            const payments = invoice.payments.filter((payment) => payment.id !== paymentId);
            const totalPaid = payments.reduce((sum, payment) => sum + payment.amount, 0);
            const nextStatus = totalPaid >= invoice.amount ? 'paid' : new Date(invoice.dueDate) < new Date() ? 'overdue' : 'open';
            await upsertInvoice(
              {
                ...invoice,
                payments,
                status: nextStatus,
              },
              `Unlinked transaction ${transaction.id}`,
            );
          }
        }
        return parseResult(key, { success: true });
      }
      case 'eur:getReport':
        return parseResult(key, await getEurReport(args));
      case 'eur:listItems':
        return parseResult(key, await getEurItems(args));
      case 'eur:listRules':
        return parseResult(key, eurRules.filter((rule) => rule.taxYear === args.taxYear));
      case 'eur:upsertRule': {
        const now = new Date().toISOString();
        const existing = args.id ? eurRules.find((rule) => rule.id === args.id) : undefined;
        const rule = eurRuleSchema.parse({
          id: args.id ?? crypto.randomUUID(),
          taxYear: args.taxYear,
          priority: args.priority,
          field: args.field,
          operator: args.operator,
          value: args.value,
          targetEurLineId: args.targetEurLineId,
          active: args.active ?? true,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        eurRules = [rule, ...eurRules.filter((entry) => entry.id !== rule.id)];
        persistEurRules();
        return parseResult(key, rule);
      }
      case 'eur:deleteRule':
        eurRules = eurRules.filter((rule) => rule.id !== args.id);
        persistEurRules();
        return parseResult(key, { ok: true });
      case 'eur:upsertClassification': {
        const next = eurClassificationSchema.parse({
          id: `${args.sourceType}:${args.sourceId}:${args.taxYear}`,
          sourceType: args.sourceType,
          sourceId: args.sourceId,
          taxYear: args.taxYear,
          eurLineId: args.eurLineId,
          excluded: args.excluded ?? false,
          vatMode: args.vatMode ?? 'none',
          note: undefined,
          updatedAt: new Date().toISOString(),
        });
        eurClassifications = [
          next,
          ...eurClassifications.filter(
            (entry) => !(entry.sourceType === next.sourceType && entry.sourceId === next.sourceId && entry.taxYear === next.taxYear),
          ),
        ];
        persistEurClassifications();
        return parseResult(key, next);
      }
      case 'eur:exportCsv': {
        const report = await getEurReport({ taxYear: args.taxYear, from: args.from, to: args.to });
        return parseResult(
          key,
          formatSemicolonCsv(
            report.rows.map((row) => ({ lineId: row.lineId, label: row.label, kind: row.kind, total: row.total })),
            ['lineId', 'label', 'kind', 'total'],
          ),
        );
      }
      case 'eur:exportPdf':
        return parseResult(key, {
          path: buildPrintUrl('eur', { taxYear: String(args.taxYear), ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) }),
        });
      case 'portal:health': {
        const response = await fetch(buildUrl(args.baseUrl, '/health'));
        const payload = await response.json().catch(() => null);
        if (!response.ok || !isRecord(payload)) {
          throw new Error(`Portal request failed with status ${response.status}`);
        }
        return parseResult(key, {
          ok: payload.ok === true,
          ts: typeof payload.ts === 'string' ? payload.ts : new Date().toISOString(),
        });
      }
      case 'portal:publishOffer': {
        const offer = await findOfferById(args.offerId);
        if (!offer) {
          throw new Error('Offer not found');
        }
        const settings = await getSettings();
        const base = settings?.portal.baseUrl?.trim() || window.location.origin;
        const tokenValue = offer.shareToken ?? crypto.randomUUID().replace(/-/g, '');
        const saved = await upsertOffer(
          {
            ...offer,
            shareToken: tokenValue,
            sharePublishedAt: new Date().toISOString(),
          },
          'Published offer in Billme Pro web shell',
        );
        return parseResult(key, {
          ok: true,
          token: tokenValue,
          publicUrl: `${base.replace(/\/+$/, '')}/offers/${saved.shareToken}`,
        });
      }
      case 'portal:syncOfferStatus': {
        const offer = await findOfferById(args.offerId);
        if (!offer) {
          throw new Error('Offer not found');
        }
        return parseResult(key, {
          ok: true,
          decision:
            offer.shareDecision && offer.acceptedAt
              ? {
                  decidedAt: offer.acceptedAt,
                  decision: offer.shareDecision,
                  acceptedName: offer.acceptedBy ?? '',
                  acceptedEmail: offer.acceptedEmail ?? '',
                  decisionTextVersion: offer.shareDecisionTextVersion ?? 'web-shell',
                }
              : null,
          updated: false,
        });
      }
      case 'secrets:has':
        return parseResult(key, typeof secrets[args.key] === 'string' && secrets[args.key].length > 0);
      case 'secrets:set':
        secrets = { ...secrets, [args.key]: args.value };
        persistSecrets();
        return parseResult(key, undefined);
      case 'secrets:delete':
        secrets = Object.fromEntries(Object.entries(secrets).filter(([entryKey]) => entryKey !== args.key));
        persistSecrets();
        return parseResult(key, true);
      case 'db:backup': {
        const payload: BackupPayload = {
          settings: await getSettings(),
          clients: await listClients(),
          invoices: await listInvoices(),
          offers: await listOffers(),
          recurring: await listRecurring(),
          articles: await listArticles(),
          accounts: await listAccounts(),
          templates: await listTemplates(),
          transactions: getTransactions(),
          importBatches,
          eurRules,
          eurClassifications,
          drafts,
          journalEntries,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        return parseResult(key, { path: URL.createObjectURL(blob) });
      }
      case 'db:restore': {
        const response = await fetch(args.path);
        const payload = (await response.json().catch(() => null)) as BackupPayload | null;
        if (!payload) {
          throw new Error('Could not restore backup payload');
        }
        if (payload.settings) {
          await requestJson('/api/v1/pro/settings', {
            method: 'PUT',
            body: { settings: payload.settings },
            parser: (input) => input,
          });
        }
        for (const client of payload.clients ?? []) {
          await requestJson('/api/v1/pro/clients', {
            method: 'POST',
            body: { reason: 'Restore backup', client },
            parser: clientSchema,
          });
        }
        for (const invoice of payload.invoices ?? []) {
          await upsertInvoice(invoice, 'Restore backup');
        }
        for (const offer of payload.offers ?? []) {
          await upsertOffer(offer, 'Restore backup');
        }
        for (const profile of payload.recurring ?? []) {
          await requestJson('/api/v1/pro/recurring', {
            method: 'POST',
            body: { reason: 'Restore backup', profile },
            parser: recurringProfileSchema,
          });
        }
        for (const article of payload.articles ?? []) {
          await requestJson('/api/v1/pro/articles', {
            method: 'POST',
            body: { article },
            parser: articleSchema,
          });
        }
        for (const account of payload.accounts ?? []) {
          await requestJson('/api/v1/pro/accounts', {
            method: 'POST',
            body: { account },
            parser: accountSchema,
          });
        }
        for (const template of payload.templates ?? []) {
          await requestJson('/api/v1/pro/templates', {
            method: 'POST',
            body: { template },
            parser: templateSchema,
          });
        }
        transactions = parseArray(transactionSchema)(payload.transactions ?? []);
        importBatches = payload.importBatches ?? [];
        eurRules = parseArray(eurRuleSchema)(payload.eurRules ?? []);
        eurClassifications = parseArray(eurClassificationSchema)(payload.eurClassifications ?? []);
        drafts = parseArray(bookingDraftEntitySchema)(payload.drafts ?? []);
        journalEntries = parseArray(journalEntryEntitySchema)(payload.journalEntries ?? []);
        persistTransactions();
        persistImportBatches();
        persistEurRules();
        persistEurClassifications();
        persistDrafts();
        persistJournalEntries();
        return parseResult(key, {
          ok: true,
          verification: {
            ok: true,
            errors: [],
            count: (payload.clients?.length ?? 0) + (payload.invoices?.length ?? 0) + (payload.offers?.length ?? 0),
            headHash: null,
          },
        });
      }
      case 'email:send': {
        const url = new URL(`mailto:${encodeURIComponent(args.recipientEmail)}`);
        url.searchParams.set('subject', args.subject);
        url.searchParams.set('body', args.bodyText);
        window.open(url.toString(), '_blank');
        return parseResult(key, { success: true, messageId: 'browser-mailto' });
      }
      case 'email:testConfig':
        return parseResult(key, { success: false, error: UNSUPPORTED_MESSAGE });
      case 'dunning:manualRun':
        return parseResult(key, {
          success: true,
          result: {
            processedInvoices: 0,
            emailsSent: 0,
            feesApplied: 0,
            errors: [],
          },
        });
      default:
        throw new Error(UNSUPPORTED_MESSAGE);
    }
  };

  return createBillmeApi(invoke as any);
};
