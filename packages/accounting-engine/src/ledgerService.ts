import type { JournalEntry, LedgerBalance } from '@billme/accounting-shared';

export const buildLedgerBalances = (entries: JournalEntry[]): LedgerBalance[] => {
  const byAccount = new Map<string, LedgerBalance>();

  for (const entry of entries) {
    // Reversed entries stay ledger-effective; their swapped lines net them to zero.
    if (entry.status !== 'posted' && entry.status !== 'reversed') continue;

    for (const line of entry.lines) {
      const current = byAccount.get(line.accountNumber) ?? {
        accountNumber: line.accountNumber,
        openingBalance: 0,
        debitTurnover: 0,
        creditTurnover: 0,
        closingBalance: 0,
      };

      current.debitTurnover += Number(line.debitAmount || 0);
      current.creditTurnover += Number(line.creditAmount || 0);
      current.closingBalance = current.openingBalance + current.debitTurnover - current.creditTurnover;
      byAccount.set(line.accountNumber, current);
    }
  }

  return Array.from(byAccount.values()).sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
};
