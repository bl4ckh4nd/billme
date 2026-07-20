import React from 'react';
import { Check, X, AlertTriangle } from 'lucide-react';
import { Button } from '@billme/ui';
import { Invoice, AppSettings } from '../../types';
import { formatCurrency, formatDate } from './helpers';

interface DunningModalProps {
  isOpen: boolean;
  onClose: () => void;
  overdueInvoices: Invoice[];
  selectedForDunning: string[];
  setSelectedForDunning: React.Dispatch<React.SetStateAction<string[]>>;
  validSelectedForDunning: string[];
  isDunningProcessing: boolean;
  onProcess: () => void;
  settings: AppSettings;
}

export const DunningModal: React.FC<DunningModalProps> = ({
  isOpen,
  onClose,
  overdueInvoices,
  selectedForDunning,
  setSelectedForDunning,
  validSelectedForDunning,
  isDunningProcessing,
  onProcess,
  settings,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-scale-in">
            <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-surface-muted">
                <div>
                  <h3 className="text-xl font-black">Mahnlauf starten</h3>
                  <p className="text-sm text-muted">{validSelectedForDunning.length} Rechnungen ausgewählt</p>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-canvas rounded-full transition-colors ease-out duration-150"><X size={20}/></button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 space-y-3">
                 {overdueInvoices.map(inv => {
                     const currentLevel = inv.dunningLevel || 0;
                     const nextLevel = Math.min(currentLevel + 1, 3);
                     const levelConfig = settings.dunning.levels.find(l => l.id === nextLevel);
                     const isSelected = selectedForDunning.includes(inv.id);

                     return (
                         <div key={inv.id} className={`p-4 rounded-xl border-2 cursor-pointer transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out duration-150 ${isSelected ? 'border-foreground bg-surface-muted' : 'border-border-subtle bg-surface hover:border-border'}`}
                              onClick={() => {
                                  if (isSelected) setSelectedForDunning((prev) => prev.filter((id) => id !== inv.id));
                                  else setSelectedForDunning((prev) => [...prev, inv.id]);
                              }}
                         >
                             <div className="flex justify-between items-center mb-2">
                                 <div className="flex items-center gap-3">
                                      <div className={`w-5 h-5 rounded border flex items-center justify-center ${isSelected ? 'bg-foreground border-foreground text-surface' : 'border-border'}`}>
                                          {isSelected && <Check size={12} />}
                                      </div>
                                      <span className="font-bold">{inv.number}</span>
                                      <span className="text-sm text-muted">{inv.client}</span>
                                 </div>
                                 <span className="tabular-nums font-bold">{formatCurrency(inv.amount)}</span>
                             </div>
                             <div className="pl-8 flex items-center gap-2 text-xs">
                                 <span className="bg-error-bg text-error px-2 py-1 rounded font-bold">Überfällig seit {new Date(inv.dueDate).toLocaleDateString()}</span>
                                 <span className="text-muted">➔</span>
                                 <span className="bg-black text-accent px-2 py-1 rounded font-bold">Wird: {levelConfig?.name} (+{formatCurrency(levelConfig?.fee || 0)})</span>
                             </div>
                         </div>
                     );
                 })}
                 {overdueInvoices.length === 0 && (
                     <p className="text-center text-muted py-8">Keine überfälligen Rechnungen gefunden.</p>
                 )}
            </div>

            <div className="p-6 border-t border-border-subtle bg-surface-muted flex justify-end gap-3">
                <button
                  onClick={() => {
                    onClose();
                    setSelectedForDunning(validSelectedForDunning);
                  }}
                  className="px-6 py-3 rounded-xl font-bold text-muted hover:bg-canvas transition-colors ease-out duration-150"
                >
                  Abbrechen
                </button>
                <Button
                  onClick={onProcess}
                  disabled={validSelectedForDunning.length === 0 || isDunningProcessing}
                  size="md"
                >
                    {isDunningProcessing ? 'Sende...' : `${validSelectedForDunning.length} Mahnungen versenden`}
                </Button>
            </div>
        </div>
    </div>
  );
};
