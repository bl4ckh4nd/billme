import { Article } from '../../types';

export const normalizeCategoryName = (value: string): string => value.trim();

export const buildConfiguredCategories = (
  settingsCategories: Array<{ id: string; name: string }> | undefined,
): string[] => {
  const normalized = (settingsCategories ?? [])
    .map((c) => normalizeCategoryName(c.name))
    .filter(Boolean);

  const unique = Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b, 'de-DE'));
  return unique.length > 0 ? unique : ['Allgemein'];
};

// Category colors - using design system semantic palette + grays
export const PASTEL_COLORS = [
    'bg-error-bg text-error',
    'bg-warning-bg text-warning',
    'bg-success-bg text-success',
    'bg-info-bg text-info',
    'bg-surface-muted text-muted',
    'bg-gray-200 text-gray-600',
    'bg-error-bg text-error',
    'bg-warning-bg text-warning',
    'bg-success-bg text-success',
    'bg-info-bg text-info',
    'bg-surface-muted text-muted',
    'bg-gray-200 text-gray-600',
];

export const getAvatarColor = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % PASTEL_COLORS.length;
    return PASTEL_COLORS[index];
};

export const getInitials = (str: string) => {
    return str.substring(0, 2).toUpperCase();
};

export const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

export const calculateDisplayPrice = (article: Article, isNetPrice: boolean) => {
    if (isNetPrice) return article.price;
    return article.price * (1 + article.taxRate / 100);
};
