import React from 'react';
import { Button } from '@billme/ui';
import { RotateCcw } from 'lucide-react';
import type { UndoChange } from './types';

type Props = {
  lastUndo: { label: string; changes: UndoChange[] } | null;
  onUndo: () => void;
  isApplying: boolean;
};

export const UndoBanner: React.FC<Props> = ({ lastUndo, onUndo, isApplying }) => {
  if (!lastUndo) return null;

  return (
    <div className="mb-4 rounded-xl border border-warning-border bg-warning-bg p-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <RotateCcw size={16} className="flex-shrink-0" />
        <span>Aktion gespeichert: <span className="font-semibold">{lastUndo.label}</span></span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={onUndo}
        disabled={isApplying}
      >
        <RotateCcw size={14} />
        Rückgängig
      </Button>
    </div>
  );
};
