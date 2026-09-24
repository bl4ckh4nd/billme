import { useEffect, useState } from 'react';

/** Matches --dur-overlay-exit in styles.css. */
export const OVERLAY_EXIT_MS = 120;

/**
 * Keeps an overlay mounted for its exit transition after `open` turns false.
 * While `closing` is true the overlay applies its exit classes; the `.ui-enter-*`
 * transition in styles.css animates them, then the overlay unmounts. Reduced
 * motion unmounts immediately. The overlay must be rendered unconditionally
 * with `open` driving it: a parent that unmounts it skips the exit.
 */
export function useExitTransition(open: boolean, durationMs = OVERLAY_EXIT_MS) {
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
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [open, mounted, durationMs]);

  return { mounted, closing };
}

/** Exit classes shared by every popover-type overlay (menu, listbox, calendar, tooltip). */
export const popoverExitClass = 'pointer-events-none scale-[0.98] opacity-0 duration-(--dur-overlay-exit)';
