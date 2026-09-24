import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../utils/cn';
import { OVERLAY_EXIT_MS } from '../utils/useExitTransition';
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
  default: 'px-4 py-3',
  compact: 'px-3.5 py-2.5',
};

/**
 * Toasts stack bottom-centre, clear of the shell chrome and the page's primary
 * actions, and rise into place. Centring uses auto margins rather than a
 * translate, because the enter transition owns the translate property.
 */
export const toastOverlayPosition = 'fixed inset-x-4 bottom-6 mx-auto w-auto max-w-md z-[var(--z-toast)]';

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
    window.setTimeout(() => setDismissed(true), OVERLAY_EXIT_MS);
  };
  // Every toast sits on the inverse surface, so every focus ring is the dark-surface ring.
  const focusRing = 'focus-visible:outline-focus-ring-dark';

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
        'ui-enter-toast no-print flex max-w-md items-center gap-3 break-words rounded-card bg-surface-inverse text-inverse-foreground shadow-lg',
        portal ? toastOverlayPosition : 'relative',
        (leaving || closing) && 'translate-y-1 opacity-0 duration-(--dur-overlay-exit) [transition-delay:0ms]',
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
            'ml-2 inline-flex min-h-6 shrink-0 items-center text-xs font-semibold underline underline-offset-2 opacity-80 motion-safe:transition-opacity motion-reduce:transition-none hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2',
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
