import React from 'react';
import { cn } from '../utils/cn';
import { popoverExitClass, useExitTransition } from '../utils/useExitTransition';
import { Portal } from './Portal';

type TooltipChildProps = {
  ref?: React.Ref<HTMLElement>;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean | 'true' | 'false';
  onPointerEnter?: React.PointerEventHandler;
  onPointerLeave?: React.PointerEventHandler;
  onPointerDown?: React.PointerEventHandler;
  onFocus?: React.FocusEventHandler;
  onBlur?: React.FocusEventHandler;
};

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement<TooltipChildProps>;
  side?: 'top' | 'bottom';
  /**
   * Link the tooltip as the child's description. Turn off when the content
   * repeats the child's accessible name, or screen readers read it twice.
   */
  describe?: boolean;
  className?: string;
}

const OPEN_DELAY_MS = 400;
// Moving between neighbouring controls shows the next tooltip at once.
const GROUP_WINDOW_MS = 800;
// Title bar (40px) plus the tooltip's own height.
const FLIP_THRESHOLD_PX = 72;
let lastClosedAt = 0;

// Only keyboard focus shows the tooltip; a mouse press already dismissed it.
const isFocusVisible = (element: HTMLElement): boolean => {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
};

/**
 * Short supplementary label for a control, shown on hover and keyboard focus.
 * Never the only place a name lives: icon-only controls still need aria-label.
 * It attaches to the child itself (no wrapper), stays hidden while the child's
 * menu or panel is expanded, and a press dismisses it.
 */
export const Tooltip: React.FC<TooltipProps> = ({ content, children, side = 'top', describe = true, className }) => {
  const tooltipId = React.useId();
  const anchorRef = React.useRef<HTMLElement | null>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const [open, setOpen] = React.useState(false);
  const [coords, setCoords] = React.useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);
  const { mounted, closing } = useExitTransition(open);
  const childProps = children.props;
  const expanded = childProps['aria-expanded'] === true || childProps['aria-expanded'] === 'true';

  const place = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Flip below when there is no room above (header controls under the title bar).
    const placed = side === 'top' && rect.top < FLIP_THRESHOLD_PX ? 'bottom' : side;
    setCoords({ top: placed === 'top' ? rect.top - 6 : rect.bottom + 6, left: rect.left + rect.width / 2, side: placed });
  };

  const show = () => {
    window.clearTimeout(timer.current);
    const delay = Date.now() - lastClosedAt < GROUP_WINDOW_MS ? 0 : OPEN_DELAY_MS;
    timer.current = window.setTimeout(() => {
      place();
      setOpen(true);
    }, delay);
  };

  const hide = () => {
    window.clearTimeout(timer.current);
    if (open) lastClosedAt = Date.now();
    setOpen(false);
  };

  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  React.useEffect(() => {
    if (expanded) hide();
  }, [expanded]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const childRef = childProps.ref;
  const setRef = React.useCallback((node: HTMLElement | null) => {
    anchorRef.current = node;
    if (typeof childRef === 'function') childRef(node);
    else if (childRef) (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
  }, [childRef]);

  const visible = open && !expanded;
  const describedBy = [childProps['aria-describedby'], visible && describe ? tooltipId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <>
      {React.cloneElement(children, {
        ref: setRef,
        'aria-describedby': describedBy,
        onPointerEnter: (event: React.PointerEvent) => {
          childProps.onPointerEnter?.(event);
          if (event.pointerType !== 'touch' && !expanded) show();
        },
        onPointerLeave: (event: React.PointerEvent) => { childProps.onPointerLeave?.(event); hide(); },
        onPointerDown: (event: React.PointerEvent) => { childProps.onPointerDown?.(event); hide(); },
        onFocus: (event: React.FocusEvent) => {
          childProps.onFocus?.(event);
          if (!expanded && isFocusVisible(event.target as HTMLElement)) show();
        },
        onBlur: (event: React.FocusEvent) => { childProps.onBlur?.(event); hide(); },
      })}
      {mounted && coords && !expanded && (
        <Portal>
          <span
            id={tooltipId}
            role="tooltip"
            style={{ position: 'fixed', top: coords.top, left: coords.left }}
            className={cn(
              'ui-enter-popover pointer-events-none z-[var(--z-dropdown)] -translate-x-1/2 whitespace-nowrap rounded-sm bg-surface-inverse px-2 py-1 text-caption font-medium text-inverse-foreground',
              coords.side === 'top' ? '-translate-y-full [--origin:bottom_center]' : '[--origin:top_center]',
              closing && popoverExitClass,
              className,
            )}
          >
            {content}
          </span>
        </Portal>
      )}
    </>
  );
};

Tooltip.displayName = 'Tooltip';
