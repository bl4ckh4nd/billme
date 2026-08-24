import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBinary = path.join(path.dirname(path.join(repoRoot, 'node_modules/electron/index.js')), 'dist', 'electron');
const APP_PATHS = {
  desktop: {
    cwd: path.join(repoRoot, 'apps', 'desktop'),
    rendererRoot: path.join(repoRoot, 'apps', 'desktop', 'dist', 'renderer'),
  },
  pro: {
    cwd: path.join(repoRoot, 'apps', 'pro-desktop'),
    rendererRoot: path.join(repoRoot, 'apps', 'pro-desktop', 'dist', 'renderer'),
  },
};

export const currentYear = new Date().getFullYear();
const todayIso = new Date().toISOString().slice(0, 10);

export const appUrl = (baseUrl, route = '/') => {
  const normalized = route.startsWith('/') ? route : `/${route}`;
  return `${baseUrl}/#${normalized}`;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

let proImportSequence = 0;

const mergeRecord = (target, source) => {
  const output = { ...target };
  for (const [key, value] of Object.entries(source ?? {})) {
    const current = output[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      output[key] = mergeRecord(current, value);
      continue;
    }
    output[key] = value;
  }
  return output;
};

const BASE_SETTINGS = {
  company: {
    name: 'Billme E2E GmbH',
    owner: 'E2E Owner',
    street: 'Teststrasse 1',
    zip: '10115',
    city: 'Berlin',
    email: 'test@billme-e2e.local',
    phone: '+49 30 12345678',
    website: 'https://billme-e2e.local',
  },
  catalog: {
    categories: [
      { id: 'cat-consulting', name: 'Consulting' },
      { id: 'cat-dev', name: 'Entwicklung' },
      { id: 'cat-hosting', name: 'Hosting' },
    ],
  },
  finance: {
    bankName: 'Berliner Testbank',
    iban: 'DE12100500001234567890',
    bic: 'BELADEBEXXX',
    taxId: '12/345/67890',
    vatId: 'DE123456789',
    registerCourt: 'Amtsgericht Berlin HRB 123456',
  },
  numbers: {
    invoicePrefix: 'RE-%Y-',
    nextInvoiceNumber: 200,
    numberLength: 3,
    offerPrefix: 'ANG-%Y-',
    nextOfferNumber: 100,
    customerPrefix: 'KD-',
    nextCustomerNumber: 1,
    customerNumberLength: 4,
  },
  dunning: {
    levels: [
      {
        id: 1,
        name: 'Zahlungserinnerung',
        enabled: true,
        daysAfterDueDate: 7,
        fee: 0,
        subject: 'Zahlungserinnerung Rechnung %N',
        text: 'Bitte begleichen Sie die offene Rechnung %N.',
      },
      {
        id: 2,
        name: '1. Mahnung',
        enabled: true,
        daysAfterDueDate: 14,
        fee: 2.5,
        subject: '1. Mahnung Rechnung %N',
        text: 'Dies ist die erste Mahnung zur Rechnung %N.',
      },
      {
        id: 3,
        name: '2. Mahnung',
        enabled: true,
        daysAfterDueDate: 21,
        fee: 5,
        subject: '2. Mahnung Rechnung %N',
        text: 'Dies ist die zweite Mahnung zur Rechnung %N.',
      },
    ],
  },
  legal: {
    smallBusinessRule: true,
    defaultVatRate: 0,
    taxAccountingMethod: 'soll',
    paymentTermsDays: 14,
    defaultIntroText: 'Vielen Dank fuer Ihren Auftrag.',
    defaultFooterText: 'Es gelten unsere AGB.',
  },
  portal: {
    baseUrl: '',
  },
  eInvoice: {
    enabled: false,
    standard: 'zugferd-en16931',
    profile: 'EN16931',
    version: '2.3',
  },
  email: {
    provider: 'none',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: true,
    smtpUser: '',
    fromName: '',
    fromEmail: '',
  },
  automation: {
    dunningEnabled: false,
    dunningRunTime: '09:00',
    recurringEnabled: false,
    recurringRunTime: '03:00',
  },
  dashboard: {
    monthlyRevenueGoal: 30000,
    dueSoonDays: 7,
    topCategoriesLimit: 5,
    recentPaymentsLimit: 5,
    topClientsLimit: 5,
  },
  onboardingCompleted: true,
};

const BASE_CLIENTS = [
  {
    id: 'c1',
    customerNumber: 'KD-0001',
    company: 'Musterfirma GmbH',
    contactPerson: 'Max Mustermann',
    email: 'buchhaltung@musterfirma.de',
    phone: '+49 30 12345678',
    address: 'Musterstrasse 123, 12345 Musterstadt',
    status: 'active',
    tags: ['VIP'],
    notes: 'E2E seed client',
    projects: [],
    activities: [],
  },
  {
    id: 'c2',
    customerNumber: 'KD-0002',
    company: 'StartUp Berlin AG',
    contactPerson: 'Julia Design',
    email: 'hello@startup-berlin.io',
    phone: '+49 170 9876543',
    address: 'Torstrasse 5, 10119 Berlin',
    status: 'active',
    tags: ['Startup'],
    notes: 'E2E seed client',
    projects: [],
    activities: [],
  },
];

const BASE_ARTICLE = {
  id: 'art-seed-1',
  sku: 'DEV-001',
  title: 'Senior Entwicklung',
  description: 'Entwicklungsleistung',
  price: 120,
  unit: 'Std',
  category: 'Entwicklung',
  taxRate: 19,
};

const BASE_INVOICES = [
  {
    id: 'inv-paid-1',
    clientId: 'c1',
    clientNumber: 'KD-0001',
    number: 'RE-2026-001',
    client: 'Musterfirma GmbH',
    clientEmail: 'buchhaltung@musterfirma.de',
    clientAddress: 'Musterstrasse 123\n12345 Musterstadt',
    date: '2026-01-15',
    dueDate: '2026-01-29',
    servicePeriod: '2026-01',
    amount: 1250,
    status: 'paid',
    dunningLevel: 0,
    items: [{ kind: 'item', description: 'Webdesign Entwurf', quantity: 1, price: 1250, total: 1250 }],
    payments: [{ id: 'pay-1', date: '2026-01-20', amount: 1250, method: 'Bankueberweisung' }],
    history: [{ date: '2026-01-15', action: 'Rechnung erstellt' }],
  },
  {
    id: 'inv-open-1',
    clientId: 'c2',
    clientNumber: 'KD-0002',
    number: 'RE-2026-002',
    client: 'StartUp Berlin AG',
    clientEmail: 'hello@startup-berlin.io',
    clientAddress: 'Torstrasse 5\n10119 Berlin',
    date: '2026-02-01',
    dueDate: '2026-02-15',
    servicePeriod: '2026-02',
    amount: 3450.5,
    status: 'open',
    dunningLevel: 0,
    items: [
      { kind: 'item', description: 'Consulting Workshop', quantity: 1, price: 1200, total: 1200 },
      { kind: 'item', description: 'Strategiepapier', quantity: 1, price: 1500, total: 1500 },
      { kind: 'item', description: 'Projektbegleitung', quantity: 5, price: 150.1, total: 750.5 },
    ],
    payments: [],
    history: [{ date: '2026-02-01', action: 'Rechnung erstellt' }],
  },
];

const BASE_OFFER = {
  id: 'offer-open-1',
  clientId: 'c2',
  clientNumber: 'KD-0002',
  number: 'ANG-2026-001',
  client: 'StartUp Berlin AG',
  clientEmail: 'hello@startup-berlin.io',
  date: '2026-03-01',
  dueDate: '2026-03-15',
  servicePeriod: '2026-03',
  amount: 990,
  status: 'open',
  items: [{ kind: 'item', description: 'UX Audit', quantity: 1, price: 990, total: 990 }],
  payments: [],
  history: [{ date: '2026-03-01', action: 'Angebot erstellt' }],
  shareDecision: 'accepted',
  acceptedAt: '2026-03-05T12:00:00.000Z',
  acceptedBy: 'Julia Design',
  acceptedEmail: 'hello@startup-berlin.io',
  acceptedUserAgent: 'Playwright E2E',
};

const BASE_ACCOUNT = {
  id: 'acc1',
  name: 'Hauptgeschaeftskonto',
  iban: 'DE12345678901234567890',
  balance: 124500,
  defaultSkrAccountNumber: '1200',
  type: 'bank',
  color: 'bg-white',
  transactions: [
    {
      id: 'tx-1',
      date: '2026-02-02',
      amount: 3450.5,
      type: 'income',
      counterparty: 'StartUp Berlin AG',
      purpose: 'Gutschrift',
      status: 'booked',
    },
    {
      id: 'tx-2',
      date: '2026-02-05',
      amount: -49.9,
      type: 'expense',
      counterparty: 'Adobe Systems',
      purpose: 'Creative Cloud Abo',
      status: 'booked',
    },
    {
      id: 'tx-3',
      date: '2026-01-20',
      amount: 1250,
      type: 'income',
      counterparty: 'Musterfirma GmbH',
      purpose: 'Rechnung RE-2026-001',
      linkedInvoiceId: 'inv-paid-1',
      status: 'booked',
    },
  ],
};

const BASE_RECURRING = {
  id: 'rec-seed-1',
  clientId: 'c1',
  active: true,
  name: 'Wartungsvertrag Basis',
  interval: 'monthly',
  nextRun: todayIso,
  amount: 150,
  items: [{ description: 'Monatliche Wartung', quantity: 1, price: 150, total: 150 }],
};

export const createDesktopSettings = (overrides = {}) => {
  const base = clone(BASE_SETTINGS);
  return mergeRecord(base, overrides);
};

const contentTypeFor = (filePath) => {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.png':
      return 'image/png';
    case '.map':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
};

const readStaticFile = async (rootDir, requestPath) => {
  const safePath = decodeURIComponent(requestPath).replace(/^\/+/, '');
  const resolved = path.join(rootDir, safePath);

  const candidates = [resolved];
  if (requestPath.endsWith('/')) candidates.push(path.join(resolved, 'index.html'));
  candidates.push(path.join(rootDir, 'index.html'));

  for (const filePath of candidates) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) continue;
      return { body: await fs.promises.readFile(filePath), filePath };
    } catch {
      continue;
    }
  }

  const fallbackPath = path.join(rootDir, 'index.html');
  return { body: await fs.promises.readFile(fallbackPath), filePath: fallbackPath };
};

const startStaticServer = async (rootDir) => {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const { body, filePath } = await readStaticFile(rootDir, url.pathname);
      res.statusCode = 200;
      res.setHeader('content-type', contentTypeFor(filePath));
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start local renderer server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
};

const appConfig = (app) => {
  if (app === 'desktop' || app === 'pro') return APP_PATHS[app];
  throw new Error(`Unsupported e2e app target: ${String(app)}`);
};

export async function launchDesktopApp(options = {}) {
  const app = options.app ?? 'desktop';
  const { cwd, rendererRoot } = appConfig(app);
  const rendererServer = await startStaticServer(rendererRoot);
  const userDataDir = options.userDataDir ?? await fs.promises.mkdtemp(path.join(os.tmpdir(), `billme-${app}-e2e-`));
  const cleanupUserData = options.cleanupUserData !== false && options.userDataDir === undefined;
  const cacheDir = path.join(userDataDir, 'cache');
  const connectionFile = path.join(userDataDir, '.e2e-embedded-connection.json');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const launchedApp = await electron.launch({
    executablePath: electronBinary,
    cwd,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${userDataDir}`, '.'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      BILLME_E2E: '1',
      BILLME_E2E_USER_DATA_DIR: userDataDir,
      BILLME_E2E_CACHE_DIR: cacheDir,
      BILLME_E2E_CONNECTION_FILE: connectionFile,
      BILLME_SERVER_DATA_MIGRATIONS_DIR: path.join(repoRoot, 'packages', 'server-data', 'drizzle'),
      VITE_DEV_SERVER_URL: rendererServer.baseUrl,
    },
  });

  const page = await launchedApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.billmeApi));

  const closeElectronApp = async () => {
    let child;
    try {
      child = launchedApp.process();
    } catch {
      child = undefined;
    }
    await Promise.race([
      launchedApp.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  };

  return {
    app: launchedApp,
    page,
    baseUrl: rendererServer.baseUrl,
    userDataDir,
    targetApp: app,
    close: async () => {
      try {
        await closeElectronApp();
      } finally {
        await rendererServer.close();
        if (cleanupUserData) await fs.promises.rm(userDataDir, { recursive: true, force: true });
      }
    },
  };
}

export const readEmbeddedConnection = async (desktop) => {
  const connectionFile = path.join(desktop.userDataDir, '.e2e-embedded-connection.json');
  return JSON.parse(await fs.promises.readFile(connectionFile, 'utf8'));
};

export const requestEmbeddedJson = async (desktop, route, options = {}) => {
  const connection = await readEmbeddedConnection(desktop);
  const response = await fetch(`${connection.baseUrl}${route}`, {
    ...options,
    headers: {
      authorization: `Bearer ${connection.token}`,
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : undefined;
  } catch {
    payload = body;
  }
  if (!response.ok) {
    throw new Error(`Embedded HTTP ${response.status} ${route}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }
  return payload;
};

export async function invokeDesktopIpc(page, route, args) {
  const [group, method] = route.split(':');
  if (!group || !method) {
    throw new Error(`Invalid IPC route: ${route}`);
  }

  const result = await page.evaluate(
    async ({ apiGroup, apiMethod, payload }) => {
      const api = window.billmeApi?.[apiGroup]?.[apiMethod];
      if (typeof api !== 'function') {
        throw new Error(`Missing IPC API method: ${apiGroup}:${apiMethod}`);
      }
      return payload === undefined ? await api() : await api(payload);
    },
    { apiGroup: group, apiMethod: method, payload: args },
  );

  return result;
}

export async function getDesktopSettings(page) {
  return await invokeDesktopIpc(page, 'settings:get');
}

export async function setDesktopSettings(page, settings) {
  await invokeDesktopIpc(page, 'settings:set', { settings });
}

export async function seedDesktopData(page, options = {}) {
  const app = options.app ?? 'desktop';
  const settings = createDesktopSettings(options.settingsOverrides ?? {});
  await setDesktopSettings(page, settings);

  for (const client of BASE_CLIENTS) {
    await invokeDesktopIpc(page, 'clients:upsert', { client });
  }

  await invokeDesktopIpc(page, 'articles:upsert', { article: BASE_ARTICLE });

  for (const invoice of BASE_INVOICES) {
    await invokeDesktopIpc(page, 'invoices:upsert', {
      reason: 'E2E Seed',
      invoice,
    });
  }

  await invokeDesktopIpc(page, 'offers:upsert', {
    reason: 'E2E Seed',
    offer: BASE_OFFER,
  });

  await invokeDesktopIpc(page, 'accounts:upsert', {
    account: BASE_ACCOUNT,
  });

  await invokeDesktopIpc(page, 'recurring:upsert', {
    profile: BASE_RECURRING,
  });

  if (app === 'pro') {
    const statsBefore = await invokeDesktopIpc(page, 'pro:getLedgerStats');
    if ((statsBefore?.total ?? 0) === 0) {
      await invokeDesktopIpc(page, 'pro:importSkr', { preferredSource: 'auto' });
    }
  }
}

export async function importPendingProTransaction(page, label, options = {}) {
  const nonce = `${process.pid}-${Date.now()}-${proImportSequence++}`;
  const externalId = `e2e-pro-${label}-${nonce}`;
  const csvPath = path.join(os.tmpdir(), `${externalId}.csv`);
  const date = options.date ?? '2026-04-01';
  const amount = options.amount ?? -120;
  const counterparty = options.counterparty ?? `E2E ${label}`;
  const purpose = options.purpose ?? `E2E ${label}`;
  await fs.promises.writeFile(
    csvPath,
    `date,amount,counterparty,purpose,status,externalId\n${date},${amount},${counterparty},${purpose},pending,${externalId}\n`,
    'utf8',
  );
  try {
    const imported = await invokeDesktopIpc(page, 'finance:importCommit', {
      path: csvPath,
      accountId: 'acc1',
      profile: 'generic',
      mapping: {
        dateColumn: 'date',
        amountColumn: 'amount',
        counterpartyColumn: 'counterparty',
        purposeColumn: 'purpose',
        statusColumn: 'status',
        externalIdColumn: 'externalId',
      },
    });
    if (imported.imported !== 1) throw new Error(`Expected one imported Pro transaction, got ${imported.imported}`);
  } finally {
    await fs.promises.unlink(csvPath).catch(() => undefined);
  }

  const transaction = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.id === externalId || row.purpose === purpose);
  if (!transaction) throw new Error(`Imported Pro transaction not found: ${purpose}`);
  const draft = await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id });
  if (!draft?.id) throw new Error(`Imported Pro draft not found: ${transaction.id}`);
  return { transaction, draft };
}

export async function setProAccountingPeriodStatus(desktop, period, status = 'soft_locked') {
  return requestEmbeddedJson(desktop, `/api/v1/pro/accounting/periods/${encodeURIComponent(period)}`, {
    method: 'POST',
    body: JSON.stringify({ status, reason: `E2E accounting period ${status}` }),
  });
}
