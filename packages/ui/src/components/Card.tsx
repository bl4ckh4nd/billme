import React from 'react';
import { cn } from '../utils/cn';

export type CardRadius = 'md' | 'lg' | 'xl' | '2xl' | '3xl';
/**
 * flat, raised: the bordered card on the ground; cards carry no shadow.
 * inverse: the document viewport ramp.
 * An overview card is radius="2xl" padding="lg" (16px, 18px).
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
  xl: 'rounded-card',
  '2xl': 'rounded-panel',
  '3xl': 'rounded-3xl',
};

const elevationStyles: Record<CardElevation, string> = {
  flat: 'bg-surface border border-border',
  raised: 'bg-surface border border-border',
  inverse: 'bg-surface-inverse text-inverse-foreground',
};

const paddingStyles: Record<CardPadding, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-3.5',
  lg: 'p-4.5',
};

export const Card: React.FC<CardProps> = ({
  children,
  radius = 'xl',
  elevation = 'raised',
  padding = 'md',
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
