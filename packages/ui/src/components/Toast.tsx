import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
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
  onDismiss?: () => void;
  dismissLabel?: string;
  onPause?: () => void;
  onResume?: () => void;
  /** Driven by FeedbackProvider for timer expiry: plays the 150ms exit. */
  leaving?: boolean;
  /** Stack position for the 40ms enter cascade (Sonner-style stagger). */
  staggerIndex?: number;
}

const sizeStyles: Record<ToastSize, string> = {
  default: 'rounded-2xl px-6 py-3',
  compact: 'rounded-xl px-4 py-2.5',
};

/**
 * Portal toasts sit below the shell chrome: titlebar (`h-10` = 2.5rem) plus header
 * (`h-[88px]` = 5.5rem) plus 8px of air. `top-14` used to land inside the header
 * and covered the global search field and the header icon buttons.
 */
export const toastOverlayPosition = 'fixed inset-x-4 top-[8.5rem] z-[var(--z-toast)] sm:left-auto sm:right-8';

export const Toast: React.FC<ToastProps> = ({
  children,
  variant = 'success',
  size = 'default',
  className,
  action,
  portal = true,
  onDismiss,
  dismissLabel = 'Meldung schließen',
  onPause,
  onResume,
  leaving = false,
  staggerIndex = 0,
}) => {
  const isError = variant === 'error';
  const isInfo = variant === 'info' || variant === 'progress';
  const [dismissed, setDismissed] = useState(false);
  const [closing, setClosing] = useState(false);
  const isHovered = useRef(false);
  const isFocused = useRef(false);

  if (dismissed) return null;

  const dismiss = () => {
    // Provider-owned toasts animate via `leaving`; standalone toasts animate here.
    if (onDismiss) {
      onDismiss();
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDismissed(true);
      return;
    }
    setClosing(true);
    window.setTimeout(() => setDismissed(true), 150);
  };
  const focusRing = isError || isInfo ? 'focus-visible:outline-focus-ring' : 'focus-visible:outline-focus-ring-dark';

  const content = (
    <div
      // An error toast is often the only surface for a failed background action, so it announces assertively.
      // The other variants stay polite: ValidationSummary already owns assertive form-error announcements.
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-busy={variant === 'progress' ? true : undefined}
      onMouseEnter={() => {
        isHovered.current = true;
        onPause?.();
      }}
      onMouseLeave={() => {
        isHovered.current = false;
        if (!isFocused.current) onResume?.();
      }}
      onFocus={() => {
        isFocused.current = true;
        onPause?.();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          isFocused.current = false;
          if (!isHovered.current) onResume?.();
        }
      }}
      className={cn(
        'ui-enter-toast no-print flex max-w-md items-center gap-3 break-words',
        portal ? toastOverlayPosition : 'relative',
        (leaving || closing) && 'translate-y-2 opacity-0 duration-150 [transition-delay:0ms]',
        sizeStyles[size],
        className,
      )}
      style={staggerIndex > 0 ? { transitionDelay: `${Math.min(staggerIndex, 5) * 40}ms` } : undefined}
    >
      {children}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            'ml-2 inline-flex min-h-6 shrink-0 items-center text-xs font-bold underline underline-offset-2 opacity-80 motion-safe:transition-opacity motion-reduce:transition-none hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2',
            focusRing,
          )}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={dismiss}
        className={cn(
          'ml-auto inline-flex size-6 min-h-6 min-w-6 shrink-0 items-center justify-center rounded-full opacity-80 motion-safe:transition-opacity motion-reduce:transition-none hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2',
          focusRing,
        )}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );

  return portal ? <Portal>{content}</Portal> : content;
};
