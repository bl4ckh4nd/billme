import React from 'react';
import { X } from 'lucide-react';
import { IconButton, Kbd, Modal } from '@billme/ui';

interface ShortcutsModalProps {
  open: boolean;
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

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ open, onClose }) => {
  const titleId = React.useId();

  return (
    <Modal open={open} onClose={onClose} titleId={titleId} className="overflow-hidden">
      <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
        <h2 id={titleId} className="flex-1 text-title text-foreground">Tastenkürzel</h2>
        <IconButton aria-label="Dialog schließen" size="sm" tooltip={false} onClick={onClose} className="-mr-1.5 -mt-1">
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="px-4.5 pt-1 pb-4">
        {shortcuts.map(({ keys, description }) => (
          <div
            key={keys.join('+')}
            className="flex items-center justify-between gap-4 border-b border-dashed border-border py-2 text-control text-foreground last:border-b-0"
          >
            <span>{description}</span>
            <span className="flex shrink-0 items-center gap-1">
              {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
};
