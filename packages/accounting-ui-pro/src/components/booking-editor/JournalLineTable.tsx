import { Plus, Save } from 'lucide-react';
import { BookingDraft, JournalLine, ValidationIssue } from '../../types';
import ValidationSummary from '../ValidationSummary';
import JournalLineRow from './JournalLineRow';

interface JournalLineTableProps {
  draft: BookingDraft;
  readOnly: boolean;
  busy: boolean;
  blocking: boolean;
  validationIssues: ValidationIssue[];
  onAddLine: () => void;
  onRemoveLine: (id: string) => void;
  onUpdateLine: (id: string, updater: (line: JournalLine) => JournalLine) => void;
  onSaveDraft: () => void;
}

export default function JournalLineTable({
  draft,
  readOnly,
  busy,
  blocking,
  validationIssues,
  onAddLine,
  onRemoveLine,
  onUpdateLine,
  onSaveDraft,
}: JournalLineTableProps) {
  return (
    <>
      <ValidationSummary issues={validationIssues} />

      <div className="border border-border rounded-xl overflow-hidden flex-1 flex flex-col min-h-0">
        <div className="p-4 border-b border-border bg-surface-muted flex items-center justify-between">
          <h3 className="text-sm font-bold text-foreground">Buchungssatz</h3>
          <div className="text-xs text-muted font-medium">
            {draft.lines.length} Zeilen • {blocking ? 'Blocker vorhanden' : 'Prüfbar'}
          </div>
        </div>

        <div className="overflow-auto">
          <div className="grid grid-cols-12 gap-3 px-4 py-3 text-xs font-bold uppercase tracking-wide text-muted border-b border-border-subtle">
            <div className="col-span-1">S/H</div>
            <div className="col-span-4">Konto</div>
            <div className="col-span-2">KSt.</div>
            <div className="col-span-2">Steuerfall</div>
            <div className="col-span-2 text-right">Betrag</div>
            <div className="col-span-1 text-right">-</div>
          </div>

          <div className="divide-y divide-border-subtle">
            {draft.lines.map((line) => (
              <JournalLineRow
                key={line.id}
                line={line}
                readOnly={readOnly}
                lineCount={draft.lines.length}
                onUpdateLine={onUpdateLine}
                onRemoveLine={onRemoveLine}
              />
            ))}
          </div>
        </div>

        <div className="p-3 border-t border-border-subtle bg-surface-muted/50 flex items-center justify-between">
          <button
            onClick={onAddLine}
            disabled={readOnly}
            className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-muted hover:bg-surface-muted disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Plus size={15} />
            Zeile hinzufügen
          </button>
          <button
            onClick={onSaveDraft}
            disabled={busy}
            className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1"
          >
            <Save size={15} />
            Speichern
          </button>
        </div>
      </div>
    </>
  );
}
