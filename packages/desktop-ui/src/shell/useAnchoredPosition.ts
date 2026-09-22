import React from 'react';

export interface AnchoredPosition {
  /** Fixed-position offset from the viewport top. */
  top: number;
  /** Fixed-position offset from the viewport right edge. */
  right: number;
}

/**
 * Places a portalled panel directly below its trigger, right-aligned, and keeps
 * it anchored while the shell scrolls or resizes. A portal cannot inherit the
 * trigger's layout position, so the coordinates are measured from the trigger
 * rect instead.
 */
export const useAnchoredPosition = (
  anchorRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  offset = 8,
): AnchoredPosition => {
  const [position, setPosition] = React.useState<AnchoredPosition>({ top: 0, right: 0 });

  React.useEffect(() => {
    if (!open) return undefined;

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setPosition({
        top: rect.bottom + offset,
        right: window.innerWidth - rect.right,
      });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorRef, open, offset]);

  return position;
};
