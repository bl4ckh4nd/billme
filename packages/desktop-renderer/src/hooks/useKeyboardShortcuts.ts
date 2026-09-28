import { useEffect } from 'react';

export type ShortcutContext = {
  onNew?: () => void;
  onEdit?: () => void;
  onShowShortcuts?: () => void;
  onSave?: () => void;
  onExportPdf?: () => void;
  onDelete?: () => void;
};

/**
 * Binds only the shortcuts the caller actually handles. Unhandled keys keep
 * their native behaviour (e.g. Ctrl+P prints in the browser shell).
 */
export const useKeyboardShortcuts = (context: ShortcutContext): void => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isEditing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      const isMod = e.metaKey || e.ctrlKey;
      const run = (action?: () => void) => {
        if (!action) return false;
        e.preventDefault();
        action();
        return true;
      };

      if (isMod && e.key === 's') {
        run(context.onSave);
        return;
      }

      if (isMod && e.key === 'p') {
        run(context.onExportPdf);
        return;
      }

      if (isEditing || isMod || e.altKey) return;

      if (e.key === '?') run(context.onShowShortcuts);
      else if (e.key === 'n' || e.key === 'N') run(context.onNew);
      else if (e.key === 'e' || e.key === 'E') run(context.onEdit);
      else if (e.key === 'Backspace' || e.key === 'Delete') run(context.onDelete);
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [context]);
};
