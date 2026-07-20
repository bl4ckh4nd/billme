import { claimMobilePushBatch, completeMobilePush } from '@billme/server-data';
import type { Pool } from 'pg';

export const dispatchMobilePushBatch = async (pool: Pool): Promise<{ claimed: number; sent: number; failed: number }> => {
  const entries = await claimMobilePushBatch(pool);
  let sent = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.tokens.length === 0) {
      await completeMobilePush(pool, entry.id);
      continue;
    }
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(entry.tokens.map((to) => ({ to, title: entry.title, body: entry.body, data: { route: entry.route }, sound: 'default' }))),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`EXPO_PUSH_${response.status}`);
      const payload = await response.json() as { data?: Array<{ status?: string; message?: string }> };
      const ticketError = payload.data?.find((ticket) => ticket.status === 'error')?.message;
      if (ticketError) throw new Error(ticketError);
      await completeMobilePush(pool, entry.id);
      sent += 1;
    } catch (error) {
      await completeMobilePush(pool, entry.id, error instanceof Error ? error.message.slice(0, 200) : 'PUSH_FAILED');
      failed += 1;
    }
  }
  return { claimed: entries.length, sent, failed };
};
