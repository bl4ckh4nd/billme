import React from 'react';
import { AlertTriangle } from 'lucide-react';

export const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

export const formatDate = (dateString: string) => {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const getDisplayLineTotal = (item: Pick<{ quantity: number; price: number; total: number }, 'quantity' | 'price' | 'total'>) => {
  const quantity = Number(item.quantity);
  const price = Number(item.price);
  if (Number.isFinite(quantity) && Number.isFinite(price)) {
    return round2(quantity * price);
  }
  const total = Number(item.total);
  return Number.isFinite(total) ? round2(total) : 0;
};

export const getDunningBadge = (level: number | undefined) => {
    if (!level || level === 0) return null;
    let label = '';
    let colorClass = '';
    switch(level) {
        case 1:
            label = '1. Mahnung';
            colorClass = 'bg-warning-bg text-warning border-warning-border';
            break;
        case 2:
            label = '2. Mahnung';
            colorClass = 'bg-error-bg text-error border-error-border';
            break;
        case 3:
            label = 'Inkasso';
            colorClass = 'bg-dark-base text-white border-dark-base';
            break;
        default:
            return null;
    }
    return <span className={`px-2 py-1 rounded text-[10px] font-bold border ${colorClass} uppercase tracking-wide flex items-center gap-1 whitespace-nowrap`}>
        <AlertTriangle size={10} /> {label}
    </span>;
};
