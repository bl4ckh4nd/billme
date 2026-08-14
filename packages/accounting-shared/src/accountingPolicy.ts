export type AccountingPolicyErrorCode =
  | 'ACCOUNTING_CHART_LOCKED'
  | 'ACCOUNTING_CHART_MISMATCH';

/** Stable, transport-safe policy failures shared by desktop and server mode. */
export class AccountingPolicyError extends Error {
  constructor(public readonly code: AccountingPolicyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AccountingPolicyError';
  }
}
