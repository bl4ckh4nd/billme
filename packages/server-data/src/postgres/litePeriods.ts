import type { TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';

export const assertLitePeriodsOpen = async (db: PostgresQueryable, scope: TenantScope, dates: Array<string | undefined | null>) => {
  const periods = [...new Set(dates.filter((date): date is string => Boolean(date)).map((date) => date.slice(0, 7)))];
  if (!periods.length) return;
  const closed = (await db.query("SELECT period FROM accounting_periods WHERE tenant_id=$1 AND status='closed' AND period = ANY($2::text[])", [scope.tenantId, periods])).rows as Array<{ period: string }>;
  if (closed.length) throw Object.assign(new Error('LITE_PERIOD_CLOSED'), { period: closed[0]!.period });
};

export const periodClosedMessage = (period: string) => `Der Monat ${period} ist festgeschrieben; Korrekturen bitte in einem offenen Monat buchen.`;
