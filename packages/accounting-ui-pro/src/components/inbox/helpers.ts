import { BookingAction } from '../../types';

export function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
}

export function nextActionLabel(action: BookingAction | undefined): string {
  switch (action) {
    case 'approve':
      return 'Freigeben';
    case 'post':
      return 'Buchen';
    case 'submit_for_review':
      return 'Einreichen';
    default:
      return 'Buchen';
  }
}
