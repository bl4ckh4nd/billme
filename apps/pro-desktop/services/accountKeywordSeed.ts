import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { asc, count, eq } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import { normalizeGermanText } from '@billme/finance-intelligence';
import type { TenantScope } from '@billme/server-core';
import { getTenantId } from '../tenantScope';

type LedgerAccount = {
  chart: 'SKR03' | 'SKR04';
  account_number: string;
  name: string;
};

const STOPWORDS = new Set([
  'und',
  'oder',
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'auf',
  'mit',
  'fuer',
  'von',
  'im',
  'in',
  'an',
  'zu',
  'am',
  'bei',
  'ohne',
  'sonstige',
  'sonstiger',
  'konto',
  'konten',
  'kosten',
  'aufwand',
  'aufwendungen',
  'erloese',
  'erloes',
  'steuer',
]);

const tokenizeName = (value: string): string[] => {
  const normalized = normalizeGermanText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];
  const tokens = normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return Array.from(new Set(tokens));
};

type CuratedEntry = {
  labels: string[];
  keywords: string[];
};

const CURATED: CuratedEntry[] = [
  { labels: ['telefon', 'telekommunikation', 'mobilfunk', 'internet'], keywords: ['telefon', 'telekom', 'mobilfunk', 'internet'] },
  { labels: ['hosting', 'domain', 'software', 'edv'], keywords: ['hosting', 'domain', 'server', 'saas', 'software'] },
  { labels: ['miete', 'pacht', 'leasing'], keywords: ['miete', 'pacht', 'leasing'] },
  { labels: ['kfz', 'fahrt', 'fahrzeug', 'tanken'], keywords: ['kfz', 'tank', 'diesel', 'parken'] },
  { labels: ['werbung', 'marketing', 'anzeigen', 'ads'], keywords: ['werbung', 'ads', 'marketing', 'kampagne'] },
  { labels: ['steuerberater', 'buchhaltung', 'rechtsanwalt', 'anwalt'], keywords: ['steuerberater', 'buchhaltung', 'anwalt', 'rechtsanwalt'] },
  { labels: ['reise', 'hotel', 'bahn', 'flug'], keywords: ['reise', 'hotel', 'bahn', 'flug'] },
];

const pickAccountByLabels = (
  accounts: LedgerAccount[],
  labels: string[],
): LedgerAccount | undefined => {
  const scored = accounts
    .map((acc) => {
      const hay = normalizeGermanText(acc.name);
      let score = 0;
      for (const label of labels) {
        if (hay.includes(normalizeGermanText(label))) score += 1;
      }
      return { acc, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.acc.account_number.localeCompare(b.acc.account_number);
    });
  return scored[0]?.acc;
};

const insertKeyword = (
  db: Database.Database,
  args: {
    tenantId: string;
    chart: 'SKR03' | 'SKR04';
    accountNumber: string;
    keyword: string;
    source: 'name' | 'curated' | 'user' | 'import';
    now: string;
  },
): void => {
  createDrizzle(db).insert(schema.accountKeywords).values({
    id: randomUUID(),
    tenantId: args.tenantId,
    chart: args.chart,
    accountNumber: args.accountNumber,
    keyword: normalizeGermanText(args.keyword),
    source: args.source,
    active: 1,
    createdAt: args.now,
    updatedAt: args.now,
  }).onConflictDoUpdate({ target: [schema.accountKeywords.tenantId, schema.accountKeywords.chart, schema.accountKeywords.accountNumber, schema.accountKeywords.keyword], set: {
    source: args.source,
    active: 1,
    updatedAt: args.now,
  }}).run();
};

export const seedAccountKeywords = (db: Database.Database, scope: TenantScope): void => {
  const tenantId = getTenantId(scope);
  const drizzle = createDrizzle(db);
  const existing = drizzle.select({ count: count() }).from(schema.accountKeywords)
    .where(eq(schema.accountKeywords.tenantId, tenantId)).get();
  if (Number(existing?.count ?? 0) > 0) return;

  const accounts = drizzle.select({ chart: schema.ledgerAccounts.chart, account_number: schema.ledgerAccounts.accountNumber, name: schema.ledgerAccounts.name })
    .from(schema.ledgerAccounts).orderBy(asc(schema.ledgerAccounts.chart), asc(schema.ledgerAccounts.accountNumber)).all() as LedgerAccount[];
  if (accounts.length === 0) return;

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const account of accounts) {
      for (const token of tokenizeName(account.name)) {
        insertKeyword(db, {
          tenantId,
          chart: account.chart,
          accountNumber: account.account_number,
          keyword: token,
          source: 'name',
          now,
        });
      }
    }

    for (const chart of ['SKR03', 'SKR04'] as const) {
      const chartAccounts = accounts.filter((row) => row.chart === chart);
      for (const entry of CURATED) {
        const target = pickAccountByLabels(chartAccounts, entry.labels);
        if (!target) continue;
        for (const keyword of entry.keywords) {
          insertKeyword(db, {
            tenantId,
            chart,
            accountNumber: target.account_number,
            keyword,
            source: 'curated',
            now,
          });
        }
      }
    }
  });
  tx();
};
