import { useEffect, useRef } from 'react';

export interface DesignerKeyboardHandlers {
  /** When false (e.g. inline text editing), only the bypass-snap modifier is tracked. */
  enabled: boolean;
  onNudge: (dx: number, dy: number) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSelectAll: () => void;
  onEscape: () => void;
  onSave: () => void;
  onBypassSnapChange: (bypass: boolean) => void;
}

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

/** Global keyboard shortcuts for the designer canvas. */
export function useDesignerKeyboard(handlers: DesignerKeyboardHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const h = ref.current;
      if (e.key === 'Alt') h.onBypassSnapChange(true);
      if (!h.enabled && e.key === 'Escape') {
        e.preventDefault();
        h.onEscape();
        return;
      }

      if (isTypingTarget(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;

      if (mod) {
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) h.onRedo();
          else h.onUndo();
          return;
        }
        if (k === 'y') {
          e.preventDefault();
          h.onRedo();
          return;
        }
        if (k === 'd') {
          e.preventDefault();
          h.onDuplicate();
          return;
        }
        if (k === 'c') {
          h.onCopy();
          return;
        }
        if (k === 'v') {
          h.onPaste();
          return;
        }
        if (k === 'a') {
          e.preventDefault();
          h.onSelectAll();
          return;
        }
        if (k === 's') {
          e.preventDefault();
          h.onSave();
          return;
        }
        return;
      }

      if (!h.enabled) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        h.onDelete();
        return;
      }
      if (e.key === 'Escape') {
        h.onEscape();
        return;
      }

      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        h.onNudge(-step, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        h.onNudge(step, 0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        h.onNudge(0, -step);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        h.onNudge(0, step);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') ref.current.onBypassSnapChange(false);
    };
    const onBlur = () => ref.current.onBypassSnapChange(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
