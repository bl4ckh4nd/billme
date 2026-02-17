import React from 'react';
import { cn } from '../utils/cn';

export type CardRadius = 'md' | 'lg' | 'xl' | '2xl' | '3xl';

export interface CardProps {
  children: React.ReactNode;
  radius?: CardRadius;
  withBorder?: boolean;
  withShadow?: boolean;
  className?: string;
}

const radiusStyles: Record<CardRadius, string> = {
  md: 'rounded-lg',
  lg: 'rounded-xl',
  xl: 'rounded-2xl',
  '2xl': 'rounded-[2.5rem]',
  '3xl': 'rounded-[3rem]',
};

export const Card: React.FC<CardProps> = ({
  children,
  radius = '2xl',
  withBorder = true,
  withShadow = false,
  className
}) => {
  return (
    <div
      className={cn(
        'bg-surface p-6',
        radiusStyles[radius],
        withBorder && 'border border-border',
        withShadow && 'shadow-lg',
        className
      )}
    >
      {children}
    </div>
  );
};
