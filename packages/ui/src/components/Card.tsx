import React from 'react';
import { cn } from '../utils/cn';

export type CardRadius = 'md' | 'lg' | 'xl' | '2xl' | '3xl';
/**
 * flat: bordered surface for grouping inside a raised region.
 * raised: the resting card; the shadow token carries its own hairline ring.
 * inverse: the one focal element per view (DESIGN.md contrast budget).
 */
export type CardElevation = 'flat' | 'raised' | 'inverse';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps {
  children: React.ReactNode;
  radius?: CardRadius;
  elevation?: CardElevation;
  padding?: CardPadding;
  className?: string;
}

const radiusStyles: Record<CardRadius, string> = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  '3xl': 'rounded-3xl',
};

const elevationStyles: Record<CardElevation, string> = {
  flat: 'bg-surface border border-border',
  raised: 'bg-surface shadow-xs',
  inverse: 'bg-surface-inverse text-inverse-foreground',
};

const paddingStyles: Record<CardPadding, string> = {
  none: 'p-0',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
};

export const Card: React.FC<CardProps> = ({
  children,
  radius = 'xl',
  elevation = 'raised',
  padding = 'lg',
  className
}) => {
  return (
    <div
      className={cn(
        radiusStyles[radius],
        elevationStyles[elevation],
        paddingStyles[padding],
        className
      )}
    >
      {children}
    </div>
  );
};
