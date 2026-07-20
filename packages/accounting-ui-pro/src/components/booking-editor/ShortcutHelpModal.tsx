interface ShortcutHelpModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ShortcutHelpModal({ open, onClose }: ShortcutHelpModalProps) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 bg-foreground/40 flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-surface rounded-xl border border-border shadow-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-foreground">Shortcuts (MVP)</h3>
          <button onClick={onClose} className="text-sm font-bold text-muted">
            Schließen
          </button>
        </div>
        <ul className="space-y-2 text-sm text-muted">
          <li>
            <strong>Ctrl/Cmd + Enter</strong> — Primäraktion ausführen (z. B. Freigeben/Buchen)
          </li>
          <li>
            <strong>?</strong> — Shortcut-Hilfe öffnen/schließen
          </li>
          <li>
            <strong>Esc</strong> — Dialog schließen
          </li>
        </ul>
      </div>
    </div>
  );
}
