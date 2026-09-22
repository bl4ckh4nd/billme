import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../utils/cn';
import { Portal } from './Portal';

const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  titleId?: string;
  descriptionId?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  dismissOnBackdrop?: boolean;
  ariaBusy?: boolean;
  className?: string;
  children: React.ReactNode;
}

const isConnected = (element: HTMLElement) => element.isConnected !== false;

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  titleId,
  descriptionId,
  initialFocusRef,
  dismissOnBackdrop = true,
  ariaBusy = false,
  className,
  children,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Mounted stays true through the 150ms exit so overlay/panel can fade out.
  // Enter (200ms) rides @starting-style; exit is faster (150ms) per Emil.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return undefined;
    }
    if (!mounted) return undefined;
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setMounted(false);
      setClosing(false);
      return undefined;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const restoreFocus = () => {
      const previouslyFocused = previouslyFocusedRef.current;
      if (previouslyFocused && isConnected(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };

    if (!open) {
      restoreFocus();
      return undefined;
    }

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const inertElements = new Map<HTMLElement, { wasInert: boolean; hadInertAttribute: boolean }>();
    for (const child of Array.from(document.body.children)) {
      if (child === overlayRef.current) continue;
      const element = child as HTMLElement & { inert: boolean };
      inertElements.set(element, {
        wasInert: Boolean(element.inert),
        hadInertAttribute: element.hasAttribute('inert'),
      });
      element.inert = true;
      element.setAttribute('inert', '');
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const activeElement = document.activeElement;
      const activeIndex = focusable.indexOf(activeElement as HTMLElement);

      if (event.shiftKey) {
        if (activeIndex <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1]?.focus();
        }
      } else if (activeIndex === focusable.length - 1 || activeIndex === -1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    const requestedFocusTarget = initialFocusRef?.current;
    const focusTarget = requestedFocusTarget && !requestedFocusTarget.hasAttribute('disabled')
      ? requestedFocusTarget
      : panelRef.current?.querySelector<HTMLElement>(focusableSelector)
        ?? panelRef.current;
    focusTarget?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      for (const [element, state] of inertElements) {
        if (!isConnected(element)) continue;
        element.inert = state.wasInert;
        if (state.hadInertAttribute) element.setAttribute('inert', '');
        else element.removeAttribute('inert');
      }
      restoreFocus();
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <Portal>
      <div
        ref={overlayRef}
        className={cn(
          'ui-enter-fade fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center overflow-y-auto bg-dark-base/20 p-4 backdrop-blur-sm',
          closing && 'opacity-0 duration-100',
        )}
        onClick={(event) => {
          if (dismissOnBackdrop && event.target === event.currentTarget) onCloseRef.current();
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={ariaBusy || undefined}
          tabIndex={-1}
          className={cn(
            'ui-enter-panel w-full max-w-lg rounded-3xl bg-surface shadow-2xl',
            closing && 'translate-y-2 scale-[0.96] opacity-0 duration-150',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </Portal>
  );
};

Modal.displayName = 'Modal';
