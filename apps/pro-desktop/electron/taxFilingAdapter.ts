import type Database from 'better-sqlite3';
import { TaxFilingAdapter, sourceHash } from '@billme/desktop-core/electron/tax-filing/adapter';
import type { TaxFilingRecordMetadata, TaxFilingSnapshot } from '@billme/desktop-core/electron/tax-filing/types';
import { getReportSnapshot, listReportSnapshots } from '../db/proAccountingRepo';
import { resolveRuntimeProTenantScope } from '../tenantScope';

type DateRangeArgs = { periodFromDate?: unknown; periodToDate?: unknown; periodFrom?: unknown; periodTo?: unknown; asOfDate?: unknown };

const dateFromArgs = (args: unknown, key: keyof DateRangeArgs): string | undefined => {
  const value = (args && typeof args === 'object' ? (args as DateRangeArgs)[key] : undefined);
  if (typeof value !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return undefined;
  if (key.toLowerCase().includes('to')) {
    const [year, month] = value.split('-').map(Number);
    return `${value}-${String(new Date(Date.UTC(year!, month!, 0)).getUTCDate()).padStart(2, '0')}`;
  }
  return `${value}-01`;
};

const snapshotFromReport = (record: { id: string; reportType: string; args: unknown; payload: unknown; createdAt: string; sourceHash: string }): TaxFilingSnapshot | null => {
  if (record.reportType !== 'eur') return null;
  const from = dateFromArgs(record.args, 'periodFromDate') ?? dateFromArgs(record.args, 'periodFrom');
  const to = dateFromArgs(record.args, 'periodToDate') ?? dateFromArgs(record.args, 'periodTo');
  if (!from || !to) return null;
  const snapshot: TaxFilingSnapshot = {
    id: record.id,
    kind: 'euer',
    periodStart: from,
    periodEnd: to,
    payload: { reportType: record.reportType, args: record.args, payload: record.payload },
    sourceHash: '',
    status: 'frozen',
  };
  const computedHash = sourceHash(snapshot);
  return record.sourceHash === computedHash ? { ...snapshot, sourceHash: record.sourceHash } : null;
};

export const createProTaxFilingAdapter = (getUserDataPath: () => string, requireDb: () => Database.Database): TaxFilingAdapter => {
  const load = (record: TaxFilingRecordMetadata): TaxFilingSnapshot | null => {
    const saved = getReportSnapshot(requireDb(), record.id, resolveRuntimeProTenantScope());
    return saved ? snapshotFromReport(saved) : null;
  };
  return new TaxFilingAdapter({
    userDataPath: getUserDataPath(),
    resourcesPath: process.resourcesPath,
    binaryPath: process.env.BILLME_ERIC_BINARY,
    listFrozenRecords: async () => listReportSnapshots(requireDb(), resolveRuntimeProTenantScope(), 'eur')
      .map(snapshotFromReport)
      .filter((snapshot): snapshot is TaxFilingSnapshot => Boolean(snapshot))
      .map(({ id, kind, periodStart, periodEnd, sourceHash: hash, status }) => ({ id, kind, periodStart, periodEnd, sourceHash: hash, status })),
    loadFrozenSnapshot: async (record) => load(record),
  });
};
