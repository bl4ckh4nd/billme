import React from 'react';
import { cn } from '../utils/cn';

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

export const Kbd: React.FC<KbdProps> = ({ children, className }) => (
  <kbd
    className={cn(
      'inline-flex min-w-5 items-center justify-center rounded-xs border border-b-2 border-border-strong bg-surface px-1 py-px font-mono text-muted text-micro',
      className,
    )}
  >
    {children}
  </kbd>
);
