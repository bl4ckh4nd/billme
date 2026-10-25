import { test } from '@playwright/test';

/** Numbered full-page screenshots under the test's output folder. */
export const shooter = (page) => {
  let count = 0;
  return (name) => page.screenshot({ path: test.info().outputPath(`${String(++count).padStart(2, '0')}-${name}.png`), fullPage: true });
};

/** A balanced bank draft (expense against the bank) the way the workbench saves it; walk it on with approveProDraft. */
export const balancedBankDraft = ({ transaction, draft }, expense = '4930', bank = '1200') => {
  const amount = Math.abs(Number(transaction.amount));
  const date = transaction.date;
  return {
    ...draft,
    transactionId: transaction.id,
    workflowStatus: 'suggested',
    postingDate: date,
    documentDate: date,
    bookingText: `E2E ${transaction.purpose}`,
    reference: transaction.id,
    period: date.slice(0, 7),
    fiscalYear: Number(date.slice(0, 4)),
    lines: [
      { id: `${draft.id}-expense`, accountNumber: expense, debitAmount: amount, creditAmount: 0 },
      { id: `${draft.id}-bank`, accountNumber: bank, debitAmount: 0, creditAmount: amount },
    ],
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };
};

/** Local calendar day, never the UTC date of a local time. */
export const localIsoDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
