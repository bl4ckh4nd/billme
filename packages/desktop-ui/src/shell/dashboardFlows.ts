import { useQuery } from '@tanstack/react-query';
import { ipc } from '@billme/desktop-renderer/runtime-api';

type Transaction = Awaited<ReturnType<typeof ipc.transactions.list>>[number];
type EurItem = Awaited<ReturnType<typeof ipc.eur.listItems>>[number];

export interface MonthFlow {
  key: string;
  label: string;
  longLabel: string;
  income: number;
  expense: number;
}

export interface DashboardFlows {
  /** Sum of the stored account balances, or null when no account exists. */
  liquidity: number | null;
  accountCount: number;
  /** Twelve months, oldest first, ending with the current month. Gross bank amounts. */
  months: MonthFlow[];
  /** Expenses of the same twelve months, largest first. */
  expenseBreakdown: Array<{ key: string; label: string; value: number }>;
  /** What the breakdown groups by: EÜR lines once classified, otherwise payees. */
  breakdownBasis: 'eur-line' | 'counterparty';
  /** Incoming bank payments not yet matched to an invoice. */
  openTransactionCount: number;
  /** EÜR businesses only: bank items without an EÜR line. */
  unclassifiedCount: number;
}

const EUR_MIN_TAX_YEAR = 2025;
const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const lastTwelveMonths = (now: Date): MonthFlow[] =>
  Array.from({ length: 12 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
    return {
      key: monthKey(date),
      label: date.toLocaleDateString('de-DE', { month: 'short' }).replace('.', ''),
      longLabel: date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
      income: 0,
      expense: 0,
    };
  });

const ranked = (buckets: Map<string, { label: string; value: number }>) =>
  [...buckets.entries()].map(([key, entry]) => ({ key, ...entry })).sort((a, b) => b.value - a.value);

/** Pure: buckets bank transactions (and, for EÜR, classified items) into the twelve months ending with `now`. */
export const aggregateFlows = (
  transactions: readonly Transaction[],
  eurItems: readonly EurItem[] | null,
  now: Date,
): Omit<DashboardFlows, 'liquidity' | 'accountCount'> => {
  const months = lastTwelveMonths(now);
  const byMonth = new Map(months.map((month) => [month.key, month]));
  const byCounterparty = new Map<string, { label: string; value: number }>();
  let openTransactionCount = 0;

  for (const tx of transactions) {
    if (tx.type === 'income' && !tx.linkedInvoiceId) openTransactionCount += 1;
    const month = byMonth.get(tx.date.slice(0, 7));
    if (!month) continue;
    const amount = Math.abs(Number(tx.amount) || 0);
    if (tx.type === 'income') {
      month.income += amount;
      continue;
    }
    month.expense += amount;
    const label = tx.counterparty.trim() || 'Ohne Empfänger';
    const key = label.toLocaleLowerCase('de-DE');
    const entry = byCounterparty.get(key) ?? { label, value: 0 };
    entry.value += amount;
    byCounterparty.set(key, entry);
  }

  let unclassifiedCount = 0;
  const byLine = new Map<string, { label: string; value: number }>();
  for (const item of eurItems ?? []) {
    if (!byMonth.has(item.date.slice(0, 7)) || item.classification?.excluded) continue;
    if (!item.classification && item.sourceType === 'transaction') unclassifiedCount += 1;
    if (item.flowType !== 'expense' || !item.line) continue;
    const entry = byLine.get(item.line.id) ?? { label: item.line.label, value: 0 };
    entry.value += Math.abs(Number(item.amountNet) || 0);
    byLine.set(item.line.id, entry);
  }

  // ponytail: double-entry businesses fall back to payees; group by SKR account class
  // (pro:getSusaReport) once the overview gets a ledger-backed source.
  const useLines = byLine.size > 0;
  return {
    months,
    expenseBreakdown: ranked(useLines ? byLine : byCounterparty),
    breakdownBasis: useLines ? 'eur-line' : 'counterparty',
    openTransactionCount,
    unclassifiedCount,
  };
};

/**
 * Cash figures for the overview, composed from existing routes: account
 * balances, bank transactions, and for EÜR businesses the EÜR item list.
 * ponytail: aggregates in the renderer over the full transaction list; move into
 * a server-runtime overview route if transaction counts make this slow.
 */
export const useDashboardFlows = (profitDetermination: 'eur' | 'double_entry' | undefined) =>
  useQuery({
    queryKey: ['dashboard-flows', profitDetermination],
    staleTime: 30_000,
    queryFn: async (): Promise<DashboardFlows> => {
      const now = new Date();
      // EÜR items exist only for EÜR businesses; the route rejects every other profile.
      const years = profitDetermination === 'eur'
        ? [now.getFullYear() - 1, now.getFullYear()].filter((year) => year >= EUR_MIN_TAX_YEAR)
        : [];
      const [accounts, transactions, itemLists] = await Promise.all([
        ipc.accounts.list(),
        ipc.transactions.list({}),
        Promise.all(years.map((taxYear) => ipc.eur.listItems({ taxYear }))),
      ]);
      return {
        ...aggregateFlows(transactions, years.length > 0 ? itemLists.flat() : null, now),
        liquidity: accounts.length > 0 ? accounts.reduce((sum, account) => sum + (Number(account.balance) || 0), 0) : null,
        accountCount: accounts.length,
      };
    },
  });
