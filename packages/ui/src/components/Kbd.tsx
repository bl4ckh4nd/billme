import React from 'react';
import { cn } from '../utils/cn';

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

export const Kbd: React.FC<KbdProps> = ({ children, className }) => (
  <kbd
    className={cn(
      'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-surface px-1 font-sans text-caption font-medium text-muted',
      className,
    )}
  >
    {children}
  </kbd>
);
