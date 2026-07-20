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

// Literal 1:1 mapping. Dense data cards default to `xl` (32px); reserve
// `2xl`/`3xl` for hero / onboarding / modal panels.
const radiusStyles: Record<CardRadius, string> = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  '3xl': 'rounded-3xl',
};

export const Card: React.FC<CardProps> = ({
  children,
  radius = 'xl',
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
