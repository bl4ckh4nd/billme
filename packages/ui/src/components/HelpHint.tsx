import React from 'react';
import { CircleHelp } from 'lucide-react';
import { cn } from '../utils/cn';
import { popoverExitClass, useExitTransition } from '../utils/useExitTransition';
import { Portal } from './Portal';

export interface HelpHintProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  children: React.ReactNode;
  label?: string;
}

type PopupPosition = {
  top: number;
  left: number;
  width: number;
};

export const HelpHint: React.FC<HelpHintProps> = ({
  children,
  label = 'Hilfe anzeigen',
  className,
  'aria-label': ariaLabel,
  ...props
}) => {
  const anchorRef = React.useRef<HTMLButtonElement>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<PopupPosition | null>(null);
  const { mounted, closing } = useExitTransition(open);
  // Emil: delay the first tooltip, then open adjacent ones instantly.
  const openTimer = React.useRef<number | undefined>(undefined);
  const lastCloseAt = React.useRef(0);
  const generatedId = React.useId();
  const popupId = `${generatedId}-help`;

  const cancelPendingOpen = () => {
    clearTimeout(openTimer.current);
    openTimer.current = undefined;
  };

  const requestOpen = () => {
    cancelPendingOpen();
    // Follow-up within 1.5s of a close skips the delay and the enter animation.
    if (Date.now() - lastCloseAt.current < 1500) {
      setOpen(true);
      return;
    }
    openTimer.current = window.setTimeout(() => {
      openTimer.current = undefined;
      setOpen(true);
    }, 300);
  };

  const requestClose = () => {
    cancelPendingOpen();
    if (open) lastCloseAt.current = Date.now();
    setOpen(false);
  };

  // The last position survives the exit transition; it resets once the tooltip unmounts.
  React.useEffect(() => {
    if (!mounted) setPosition(null);
  }, [mounted]);

  React.useEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const popup = popupRef.current;
      if (!anchor) return;

      const anchorRect = anchor.getBoundingClientRect();
      const viewportPadding = 8;
      const availableWidth = Math.max(window.innerWidth - (viewportPadding * 2), 0);
      const popupWidth = Math.min(popup?.offsetWidth || 320, availableWidth);
      // ponytail: pre-layout width/height fallbacks keep the first paint hidden and positioned; replace with ResizeObserver if help copy becomes continuously dynamic.
      const popupHeight = popup?.offsetHeight || 120;
      const left = Math.min(
        Math.max(anchorRect.left, viewportPadding),
        Math.max(window.innerWidth - popupWidth - viewportPadding, viewportPadding),
      );
      const below = anchorRect.bottom + viewportPadding;
      const top = below + popupHeight <= window.innerHeight - viewportPadding
        ? below
        : Math.max(viewportPadding, anchorRect.top - popupHeight - viewportPadding);

      setPosition({ top, left, width: popupWidth });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return undefined;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      requestClose();
      anchorRef.current?.focus();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      requestClose();
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      requestClose();
    };

    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('focusin', closeOnOutsideFocus);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('focusin', closeOnOutsideFocus);
    };
  }, [open]);

  return (
    <span className={cn('inline-flex align-middle', className)} {...props}>
      <button
        ref={anchorRef}
        type="button"
        aria-label={open ? 'Hilfe schließen' : ariaLabel ?? label}
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-describedby={open ? popupId : undefined}
        className="ui-press inline-flex size-6 items-center justify-center rounded-full text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        onClick={() => (open ? requestClose() : requestOpen())}
        onMouseEnter={requestOpen}
        onMouseLeave={requestClose}
        onFocus={requestOpen}
        onBlur={requestClose}
      >
        <CircleHelp size={16} aria-hidden="true" />
      </button>
      {mounted && (
        <Portal>
          <div
            ref={popupRef}
            id={popupId}
            role="tooltip"
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              'ui-enter-popover fixed z-[var(--z-dropdown)] w-80 max-w-full max-h-screen overflow-auto rounded-control bg-surface-inverse p-3 text-sm text-inverse-foreground',
              closing && popoverExitClass,
            )}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              width: position?.width,
              visibility: position ? 'visible' : 'hidden',
              '--origin': 'top left',
            } as React.CSSProperties}
          >
            {children}
          </div>
        </Portal>
      )}
    </span>
  );
};

HelpHint.displayName = 'HelpHint';
