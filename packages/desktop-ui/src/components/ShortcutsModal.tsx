import React from 'react';
import { X, Keyboard } from 'lucide-react';
import { Modal } from '@billme/ui';

interface ShortcutsModalProps {
  onClose: () => void;
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? '⌘' : 'Ctrl';

// Lists only shortcuts that are actually bound somewhere in the app.
const shortcuts = [
  { keys: [mod, 'K'], description: 'Globale Suche öffnen' },
  { keys: [mod, 'S'], description: 'Beleg speichern (im Belegeditor)' },
  { keys: [mod, 'Z'], description: 'Rückgängig (im Belegeditor)' },
  { keys: [mod, 'Y'], description: 'Wiederholen (im Belegeditor)' },
  { keys: ['Esc'], description: 'Dialog schließen' },
  { keys: ['?'], description: 'Diese Übersicht anzeigen' },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ onClose }) => {
  const titleId = React.useId();

  return (
    <Modal open onClose={onClose} titleId={titleId} className="max-w-md overflow-hidden">
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-border-subtle">
              <Keyboard size={16} className="text-foreground" aria-hidden="true" />
            </div>
            <h2 id={titleId} className="text-lg font-black text-foreground">Tastenkürzel</h2>
          </div>
          <button
            type="button"
            aria-label="Dialog schließen"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-border-subtle text-muted transition-colors hover:bg-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-1">
          {shortcuts.map(({ keys, description }) => (
            <div
              key={keys.join('+')}
              className="flex items-center justify-between rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-muted"
            >
              <span className="text-sm text-foreground">{description}</span>
              <div className="ml-4 flex shrink-0 items-center gap-1">
                {keys.map((k, i) => (
                  <React.Fragment key={k}>
                    {i > 0 && <span className="text-xs text-muted">+</span>}
                    <kbd className="inline-flex min-w-[28px] items-center justify-center rounded-lg border border-border bg-border-subtle px-2 py-0.5 text-xs font-bold text-foreground">
                      {k}
                    </kbd>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
};
