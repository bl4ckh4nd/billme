import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { defaultEurTaxYear } from '@billme/accounting-shared';
import { getRendererApi, ipc } from '../../runtime-api';
import { isDecidedEurItem } from '../../components/eur/categories';

type Transaction = Awaited<ReturnType<typeof ipc.transactions.list>>[number];
type EurItem = Awaited<ReturnType<typeof ipc.eur.listItems>>[number];

// Shares the EÜR workbench's key, so the overview's queries and the open-item badge make one request per year.
/** Anlage EÜR columns "nicht abziehbar" (Geschenke, Bewirtung, Reisen, Arbeitszimmer): shown, not deducted. */
const NON_DEDUCTIBLE_KENNZIFFERN = new Set(['164', '165', '162', '168']);

const fetchEurItems = (queryClient: QueryClient, taxYear: number) =>
  queryClient.fetchQuery({ queryKey: ['eur', 'items', taxYear], queryFn: () => ipc.eur.listItems({ taxYear }), staleTime: 30_000 });

export interface MonthFlow {
  key: string;
  label: string;
  longLabel: string;
  income: number;
  expense: number;
}

export interface DashboardFlows {
  /** Sum of the current account balances (opening balance plus booked bank lines), or null when no account exists. */
  liquidity: number | null;
  accountCount: number;
  /** Twelve months, oldest first, ending with the current month. Gross bank amounts. */
  months: MonthFlow[];
  /** Expenses of the same twelve months, largest first. */
  expenseBreakdown: Array<{ key: string; label: string; value: number }>;
  /** What the breakdown groups by: EÜR lines once classified, otherwise payees. */
  breakdownBasis: 'eur-line' | 'counterparty';
  /** Incoming bank payments not yet matched to an invoice (and, for EÜR, not yet decided in "Buchen"). */
  openTransactionCount: number;
  /** EÜR businesses only: the "Offen" queue of "Buchen" for its default year, the same count as the nav badge. */
  unclassifiedCount: number;
}

const EUR_MIN_TAX_YEAR = 2025;
type TransferMarks = Array<{ id: string; isTransfer?: boolean; sourceTransactionId?: string }>;
const NEUTRAL_KINDS = new Set(['transit', 'private-withdrawal', 'private-contribution']);
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
  /** Double entry: bank rows booked as a transfer between own accounts (Geldtransit). */
  transferIds: ReadonlySet<string> = new Set(),
): Omit<DashboardFlows, 'liquidity' | 'accountCount'> => {
  const months = lastTwelveMonths(now);
  const byMonth = new Map(months.map((month) => [month.key, month]));
  const byCounterparty = new Map<string, { label: string; value: number }>();
  let openTransactionCount = 0;
  // Geldtransit and Privatentnahme/-einlage move money but are neither income nor expense.
  const neutral = new Set([...(eurItems ?? []).filter((item) => item.sourceType === 'transaction' && NEUTRAL_KINDS.has(item.kind ?? '')).map((item) => item.sourceId), ...transferIds]);

  const decided = new Set((eurItems ?? []).filter((item) => item.sourceType === 'transaction' && isDecidedEurItem(item)).map((item) => item.sourceId));
  for (const tx of transactions) {
    if (neutral.has(tx.id)) continue;
    if (tx.type === 'income' && !tx.linkedInvoiceId && !decided.has(tx.id)) openTransactionCount += 1;
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

  const queueYear = defaultEurTaxYear(now);
  const unclassifiedCount = (eurItems ?? []).filter((item) => (item.taxYear ?? Number(item.date.slice(0, 4))) === queueYear && !isDecidedEurItem(item)).length;
  const byLine = new Map<string, { label: string; value: number }>();
  for (const item of eurItems ?? []) {
    if (!byMonth.has(item.date.slice(0, 7)) || item.classification?.excluded || NEUTRAL_KINDS.has(item.kind ?? '')) continue;
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
 * The account's balance today: the opening balance entered with the account plus its booked bank lines.
 * The stored balance is only the Anfangssaldo; imports never change it.
 */
export const currentAccountBalances = (
  accounts: ReadonlyArray<{ id: string; balance: number }>,
  transactions: ReadonlyArray<Pick<Transaction, 'accountId' | 'amount' | 'type' | 'status'>>,
): Map<string, number> => {
  const balances = new Map(accounts.map((account) => [account.id, Math.round((Number(account.balance) || 0) * 100)]));
  for (const tx of transactions) {
    if (tx.status === 'pending' || !tx.accountId || !balances.has(tx.accountId)) continue;
    const cents = Math.round(Math.abs(Number(tx.amount) || 0) * 100);
    balances.set(tx.accountId, balances.get(tx.accountId)! + (tx.type === 'income' ? cents : -cents));
  }
  return new Map([...balances].map(([id, cents]) => [id, cents / 100]));
};

/**
 * Cash figures for the overview, composed from existing routes: account
 * balances, bank transactions, and for EÜR businesses the EÜR item list.
 * ponytail: aggregates in the renderer over the full transaction list; move into
 * a server-runtime overview route if transaction counts make this slow.
 */
export const useDashboardFlows = (profitDetermination: 'eur' | 'double_entry' | undefined) => {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['dashboard-flows', profitDetermination],
    enabled: Boolean(profitDetermination),
    staleTime: 30_000,
    queryFn: async (): Promise<DashboardFlows> => {
      const now = new Date();
      // EÜR items exist only for EÜR businesses; the route rejects every other profile.
      const years = profitDetermination === 'eur'
        ? [now.getFullYear() - 1, now.getFullYear()].filter((year) => year >= EUR_MIN_TAX_YEAR)
        : [];
      const [accounts, transactions, itemLists, proLines] = await Promise.all([
        ipc.accounts.list(),
        ipc.transactions.list({}),
        Promise.all(years.map((taxYear) => fetchEurItems(queryClient, taxYear))),
        // Pro marks a transfer between own accounts on its bank lines; Lite has its Geldtransit kind in the EÜR items.
        // A Lite profile an older version left on double entry has no Pro routes: no marks then.
        profitDetermination === 'double_entry' ? getRendererApi('pro').pro.listBankTransactions().catch((): TransferMarks => []) : Promise.resolve<TransferMarks>([]),
      ]);
      const transferIds = new Set(proLines.filter((line) => line.isTransfer).map((line) => line.sourceTransactionId ?? line.id));
      return {
        ...aggregateFlows(transactions, years.length > 0 ? itemLists.flat() : null, now, transferIds),
        liquidity: accounts.length > 0 ? [...currentAccountBalances(accounts, transactions).values()].reduce((sum, balance) => sum + balance, 0) : null,
        accountCount: accounts.length,
      };
    },
  });
};

/**
 * Ergebnis of the current month, Umsatz minus Aufwand: the GuV net result for
 * double-entry businesses, the EÜR surplus otherwise. Its own query so a failing
 * report leaves the rest of the overview intact.
 */
export const useMonthResult = (profitDetermination: 'eur' | 'double_entry' | undefined, profileChart?: string) => {
  const now = new Date();
  const month = monthKey(now);
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['dashboard-month-result', profitDetermination, profileChart, month],
    enabled: Boolean(profitDetermination),
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<number> => {
      const from = `${month}-01`;
      const to = `${month}-${String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
      if (profitDetermination === 'double_entry') {
        // Only here: getRendererApi('pro') also switches the mock fallback product.
        const pro = getRendererApi('pro').pro;
        // The GuV refuses a profile chart that differs from the booking chart; ask first instead of provoking the error.
        if (profileChart && (await pro.getAccountingPolicy()).activeChart !== profileChart) throw new Error('REPORT_CHART_MISMATCH');
        const report = await pro.getGuvReport({ from, to });
        if (report.blocking) throw new Error('REPORT_MAPPING_BLOCKED');
        return report.netResult;
      }
      if (now.getFullYear() < EUR_MIN_TAX_YEAR) throw new Error('EUR_TAX_YEAR_UNSUPPORTED');
      // ponytail: the EÜR report only accepts whole calendar years, so the month sums classified items
      // instead of calculateEurRows; use the report once it takes month ranges.
      // As in the EÜR (Zufluss/Abfluss): the gross amount, since VAT received is income (Kz 140) and Vorsteuer
      // paid an expense (Kz 185); the non-deductible columns (e.g. 30 % of a Bewirtung) lower no profit.
      const items = await fetchEurItems(queryClient, now.getFullYear());
      const kennzifferOf = (item: (typeof items)[number]) => item.line?.kennziffer ?? item.classification?.eurLineId?.match(/_KZ(\d+)$/)?.[1];
      const result = items
        .filter((item) => item.date.slice(0, 7) === month && item.classification?.eurLineId && !item.classification.excluded)
        .reduce((sum, item) => {
          if (item.flowType === 'income') return sum + item.amountGross;
          if (NON_DEDUCTIBLE_KENNZIFFERN.has(kennzifferOf(item) ?? '')) return sum;
          const nonDeductible = (item.splits ?? []).filter((split) => split.deductibility === 'non-deductible').reduce((parts, split) => parts + split.amountNet, 0);
          return sum - (item.amountGross - nonDeductible);
        }, 0);
      return Math.round(result * 100) / 100;
    },
  });
};
