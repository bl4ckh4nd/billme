import { BookingDraft, IssueCounts, Transaction, ValidationIssue } from '../types';
import { BookingPolicy, requiresReceipt } from './policies';

function issue(
  code: ValidationIssue['code'],
  severity: ValidationIssue['severity'],
  message: string,
  options: Partial<ValidationIssue> = {},
): ValidationIssue {
  return {
    id: `${code}-${Math.random().toString(36).slice(2, 8)}`,
    code,
    severity,
    message,
    blocking: severity === 'error',
    source: 'system',
    ...options,
  };
}

export function parseAmount(value: number | string): number {
  if (typeof value === 'number') return value;
  if (!value.trim()) return NaN;
  return Number(value.replace(',', '.'));
}

export function validateBookingDraft(
  draft: BookingDraft,
  transaction: Transaction,
  policy: BookingPolicy,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!draft.postingDate) {
    issues.push(issue('MISSING_POSTING_DATE', 'error', 'Buchungsdatum fehlt.', { fieldPath: 'postingDate' }));
  }

  if (!draft.bookingText.trim()) {
    issues.push(issue('MISSING_BOOKING_TEXT', 'error', 'Buchungstext fehlt.', { fieldPath: 'bookingText' }));
  }

  // Closed periods are decided by the server (accounting_periods); its draft validation reports them.

  let soll = 0;
  let haben = 0;

  draft.lines.forEach((line, index) => {
    if (!line.accountId) {
      issues.push(
        issue('MISSING_ACCOUNT', 'error', 'Kontierung unvollständig: Konto fehlt.', {
          fieldPath: `lines[${index}].accountId`,
        }),
      );
    }

    const amount = parseAmount(line.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      issues.push(
        issue('INVALID_AMOUNT_FORMAT', 'error', 'Betrag ist ungültig.', {
          fieldPath: `lines[${index}].amount`,
        }),
      );
      return;
    }

    if ((line.accountId.startsWith('4') || line.accountId.startsWith('8')) && !line.taxCode && !line.taxCaseKey) {
      issues.push(
        issue('MISSING_TAX_CODE', 'warning', 'Steuerschlüssel fehlt für Erlös-/Aufwandskonto.', {
          fieldPath: `lines[${index}].taxCode`,
          blocking: false,
        }),
      );
    }

    if ((line.taxCode || line.taxCaseKey) && line.accountId === '1200') {
      issues.push(
        issue('TAX_ACCOUNT_MISMATCH', 'warning', 'Steuerschlüssel auf Bankkonto prüfen.', {
          fieldPath: `lines[${index}].taxCode`,
          blocking: false,
        }),
      );
    }

    if (line.type === 'Soll') soll += amount;
    if (line.type === 'Haben') haben += amount;
  });

  if (Math.abs(soll - haben) >= 0.01) {
    issues.push(issue('UNBALANCED_ENTRY', 'error', 'Soll/Haben sind nicht ausgeglichen.'));
  }

  if (requiresReceipt(transaction, policy) && !transaction.hasReceipt) {
    issues.push(issue('MISSING_RECEIPT', 'warning', 'Beleg fehlt für ausgehende Zahlung.', { blocking: false }));
  }

  if (transaction.flags.includes('duplicate_suspected')) {
    issues.push(issue('DUPLICATE_SUSPECTED', 'warning', 'Dubletten-Verdacht: Bitte prüfen.', { blocking: false }));
  }

  return sortIssues(issues);
}

export function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const order = { error: 0, warning: 1, info: 2 };
  return [...issues].sort((a, b) => {
    const severityCompare = order[a.severity] - order[b.severity];
    if (severityCompare !== 0) return severityCompare;
    const fieldA = a.fieldPath ?? '';
    const fieldB = b.fieldPath ?? '';
    return `${fieldA}:${a.code}`.localeCompare(`${fieldB}:${b.code}`);
  });
}

export function summarizeIssues(issues: ValidationIssue[]): IssueCounts {
  return issues.reduce<IssueCounts>(
    (acc, issue) => {
      if (issue.severity === 'error') acc.errors += 1;
      if (issue.severity === 'warning') acc.warnings += 1;
      if (issue.severity === 'info') acc.infos += 1;
      return acc;
    },
    { errors: 0, warnings: 0, infos: 0 },
  );
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.blocking);
}
