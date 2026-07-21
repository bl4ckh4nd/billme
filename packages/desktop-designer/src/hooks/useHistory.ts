import { useCallback, useRef, useState } from 'react';

type Updater<T> = T | ((prev: T) => T);

interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

export interface History<T> {
  state: T;
  /** Commit a new value. `coalesce` merges rapid successive edits into one undo step. */
  set: (next: Updater<T>, options?: { coalesce?: boolean }) => void;
  /** Replace the value and clear the undo/redo stacks (e.g. loading a template). */
  reset: (value: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const COALESCE_WINDOW_MS = 500;

function resolve<T>(next: Updater<T>, prev: T): T {
  return typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
}

/** Undo/redo history over an immutable value, with optional edit coalescing. */
export function useHistory<T>(initial: T): History<T> {
  const [hist, setHist] = useState<HistoryState<T>>({ past: [], present: initial, future: [] });
  const lastPushRef = useRef(0);

  const set = useCallback((next: Updater<T>, options?: { coalesce?: boolean }) => {
    setHist((s) => {
      const value = resolve(next, s.present);
      if (value === s.present) return s;
      const now = Date.now();
      const coalesce = options?.coalesce && now - lastPushRef.current < COALESCE_WINDOW_MS && s.past.length > 0;
      lastPushRef.current = now;
      if (coalesce) {
        // Replace present without growing the undo stack.
        return { past: s.past, present: value, future: [] };
      }
      return { past: [...s.past, s.present], present: value, future: [] };
    });
  }, []);

  const reset = useCallback((value: T) => {
    lastPushRef.current = 0;
    setHist({ past: [], present: value, future: [] });
  }, []);

  const undo = useCallback(() => {
    lastPushRef.current = 0;
    setHist((s) => {
      if (s.past.length === 0) return s;
      const previous = s.past[s.past.length - 1];
      return { past: s.past.slice(0, -1), present: previous, future: [s.present, ...s.future] };
    });
  }, []);

  const redo = useCallback(() => {
    lastPushRef.current = 0;
    setHist((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[0];
      return { past: [...s.past, s.present], present: next, future: s.future.slice(1) };
    });
  }, []);

  return {
    state: hist.present,
    set,
    reset,
    undo,
    redo,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
  };
}
