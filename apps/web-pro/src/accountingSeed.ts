type TransactionBankRef = { id: string; accountId?: string };
type BankAccountRef = { id: string; defaultSkrAccountNumber: string };

/** Resolve the server-owned bank GL account for each canonical transaction. */
export const mapTransactionBankAccounts = (
  transactions: readonly TransactionBankRef[],
  bankAccounts: readonly BankAccountRef[],
): Record<string, string> => {
  const byId = new Map(bankAccounts.map((account) => [account.id, account.defaultSkrAccountNumber]));
  return Object.fromEntries(
    transactions.flatMap((transaction) => {
      const accountNumber = transaction.accountId ? byId.get(transaction.accountId) : undefined;
      return accountNumber ? [[transaction.id, accountNumber] as const] : [];
    }),
  );
};
