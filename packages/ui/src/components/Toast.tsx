import React from 'react';
import { cn } from '../utils/cn';
import { Portal } from './Portal';

export type ToastVariant = 'success' | 'error' | 'info' | 'progress';
export type ToastSize = 'default' | 'compact';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  children: React.ReactNode;
  variant?: ToastVariant;
  size?: ToastSize;
  className?: string;
  action?: ToastAction;
  portal?: boolean;
}

const sizeStyles: Record<ToastSize, string> = {
  default: 'rounded-full px-6 py-3',
  compact: 'rounded-xl px-4 py-2.5',
};

export const Toast: React.FC<ToastProps> = ({
  children,
  variant = 'success',
  size = 'default',
  className,
  action,
  portal = true,
}) => {
  const isError = variant === 'error';
  const isInfo = variant === 'info' || variant === 'progress';

  const content = (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-busy={variant === 'progress' ? true : undefined}
      className={cn(
        'no-print shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2',
        portal ? 'fixed top-14 right-8 z-50' : 'relative',
        isError
          ? 'bg-error-bg text-error border border-error-border'
          : isInfo
            ? 'bg-info-bg text-info border border-info-border'
            : 'bg-dark-base text-accent',
        sizeStyles[size],
        className
      )}
    >
      {children}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="ml-2 shrink-0 text-xs font-bold underline underline-offset-2 opacity-80 hover:opacity-100 transition-opacity"
        >
          {action.label}
        </button>
      )}
    </div>
  );

  return portal ? <Portal>{content}</Portal> : content;
};
