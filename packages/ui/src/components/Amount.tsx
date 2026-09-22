import React from 'react';
import { cn } from '../utils/cn';
import { EMPTY_VALUE } from '../utils/format';

export type AmountSign = 'auto' | 'always' | 'accounting';

export interface AmountProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  value: number;
  sign?: AmountSign;
}

const euroFormatter = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  currencyDisplay: 'symbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const spokenAmount = (value: number, negative: boolean, sign: AmountSign): string => {
  const prefix = negative ? 'minus ' : sign === 'always' ? 'plus ' : '';
  return `${prefix}${numberFormatter.format(Math.abs(value))} Euro`;
};

export const Amount = React.forwardRef<HTMLSpanElement, AmountProps>(
  ({ value, sign = 'auto', className, 'aria-label': ariaLabel, ...props }, ref) => {
    if (!Number.isFinite(value)) {
      // ponytail: non-finite amounts stay visibly unavailable; replace with a domain-specific missing-value state if one is introduced.
      return (
        <span
          ref={ref}
          className={cn('block text-right tabular-nums', className)}
          aria-label={ariaLabel ?? 'Betrag nicht verfügbar'}
          {...props}
        >
          {EMPTY_VALUE}
        </span>
      );
    }

    const negative = value < 0;
    const formatted = euroFormatter.format(Math.abs(value));
    const displayValue = sign === 'accounting' && negative
      ? `(${formatted})`
      : negative
        ? `-${formatted}`
        : sign === 'always'
          ? `+${formatted}`
          : formatted;

    return (
      <span
        ref={ref}
        className={cn(
          'block text-right tabular-nums',
          negative && 'font-semibold',
          className,
        )}
        aria-label={ariaLabel ?? spokenAmount(value, negative, sign)}
        {...props}
      >
        {displayValue}
      </span>
    );
  },
);

Amount.displayName = 'Amount';
