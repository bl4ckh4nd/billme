import React from 'react';

export type AnchorAlign = 'start' | 'end';

export interface AnchoredStyle {
  style: React.CSSProperties;
  /** True once measured; render hidden until then. */
  ready: boolean;
}

/**
 * Fixed-position coordinates for a portalled overlay below (or, without room,
 * above) its trigger, aligned to the trigger's start or end edge. Emits
 * `--origin` so `.ui-enter-popover` grows from the side facing the trigger.
 * The last position is kept after close so the exit transition stays in place.
 */
export function useAnchoredPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  overlayRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  { align = 'start', offset = 6 }: { align?: AnchorAlign; offset?: number } = {},
): AnchoredStyle {
  const [state, setState] = React.useState<AnchoredStyle>({ style: { visibility: 'hidden' }, ready: false });

  React.useLayoutEffect(() => {
    if (!open) return undefined;

    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const overlayHeight = overlayRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - anchor.bottom - offset - 8;
      const above = overlayHeight > spaceBelow && anchor.top - offset - 8 > spaceBelow;
      const vertical = above
        ? { bottom: window.innerHeight - anchor.top + offset }
        : { top: anchor.bottom + offset };
      const horizontal = align === 'end'
        ? { right: Math.max(8, window.innerWidth - anchor.right) }
        : { left: Math.max(8, anchor.left) };
      const style: React.CSSProperties & { '--origin': string } = {
        position: 'fixed',
        ...vertical,
        ...horizontal,
        '--origin': `${above ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`,
      };
      setState({ ready: true, style });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, overlayRef, open, align, offset]);

  return state;
}
