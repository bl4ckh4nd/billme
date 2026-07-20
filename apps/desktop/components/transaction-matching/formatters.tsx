import React from 'react';
import { CheckCircle2 } from 'lucide-react';

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount);
};

export const formatDate = (dateStr: string): string => {
  return new Date(dateStr).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
};

export const getConfidenceBadge = (confidence: 'high' | 'medium' | 'low'): React.ReactNode => {
  const styles = {
    high: 'bg-success-bg text-success border-success/30',
    medium: 'bg-warning-bg text-warning border-warning-border',
    low: 'bg-canvas text-muted border-border',
  };
  const labels = {
    high: 'Hohe Übereinstimmung',
    medium: 'Mittlere Übereinstimmung',
    low: 'Geringe Übereinstimmung',
  };
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium border ${styles[confidence]}`}>
      {labels[confidence]}
    </span>
  );
};
