import { BookingAction } from '../../types';

export function formatCurrency(amount: number | string, currency: string) {
  const num = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  const safe = Number.isFinite(num) ? num : 0;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(safe);
}

export function parseAmountInput(value: string) {
  return value.replace(',', '.');
}

export function actionRequiresConfirmation(action: BookingAction) {
  return action === 'reverse' || action === 'reject';
}
