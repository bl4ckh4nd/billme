import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface ShortcutsModalProps {
  onClose: () => void;
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? '⌘' : 'Ctrl';

const shortcuts = [
  { keys: ['N'], description: 'Neues Dokument / Neuen Eintrag erstellen' },
  { keys: ['E'], description: 'Ausgewähltes Dokument bearbeiten' },
  { keys: [mod, 'S'], description: 'Formular speichern' },
  { keys: [mod, 'P'], description: 'PDF exportieren' },
  { keys: [mod, 'K'], description: 'Globale Suche öffnen' },
  { keys: ['Backspace'], description: 'Ausgewähltes Element löschen' },
  { keys: ['Esc'], description: 'Modal schließen / Zurück' },
  { keys: ['?'], description: 'Diese Übersicht anzeigen' },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ onClose }) => {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-gray-100 rounded-xl flex items-center justify-center">
                <Keyboard size={16} className="text-gray-700" />
              </div>
              <h2 className="text-lg font-black text-gray-900">Tastenkürzel</h2>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-500 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="space-y-1">
            {shortcuts.map(({ keys, description }) => (
              <div
                key={keys.join('+')}
                className="flex items-center justify-between py-2.5 px-3 rounded-xl hover:bg-gray-50 transition-colors"
              >
                <span className="text-sm text-gray-700">{description}</span>
                <div className="flex items-center gap-1 shrink-0 ml-4">
                  {keys.map((k, i) => (
                    <React.Fragment key={k}>
                      {i > 0 && <span className="text-gray-300 text-xs">+</span>}
                      <kbd className="inline-flex items-center px-2 py-0.5 rounded-lg text-xs font-bold text-gray-600 bg-gray-100 border border-gray-200 min-w-[28px] justify-center">
                        {k}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
