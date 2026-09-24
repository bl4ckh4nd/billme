import React, { useEffect, useRef } from 'react';
import { cn } from '../utils/cn';
import { useExitTransition } from '../utils/useExitTransition';
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
  // Mounted stays true through the exit so overlay and panel can fade out.
  const { mounted, closing } = useExitTransition(open);

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
          closing && 'opacity-0 duration-(--dur-overlay-exit)',
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
            'ui-enter-panel w-full max-w-lg rounded-modal bg-surface shadow-lg',
            closing && 'translate-y-1 scale-[0.98] opacity-0 duration-(--dur-overlay-exit)',
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
