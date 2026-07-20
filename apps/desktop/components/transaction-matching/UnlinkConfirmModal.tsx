import React from 'react';
import { AlertCircle } from 'lucide-react';

interface UnlinkConfirmModalProps {
  isPending: boolean;
  invoiceWillBeOverdue: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const UnlinkConfirmModal: React.FC<UnlinkConfirmModalProps> = ({
  isPending,
  invoiceWillBeOverdue,
  onConfirm,
  onCancel,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="bg-surface rounded-2xl shadow-2xl w-[90%] max-w-md p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-warning-bg flex items-center justify-center flex-shrink-0">
            <AlertCircle size={20} className="text-warning" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-foreground mb-2">
              Zuordnung wirklich aufheben?
            </h3>
            <p className="text-sm text-muted mb-2">
              Diese Rechnung wird wieder als unbezahlt markiert.
            </p>
            {invoiceWillBeOverdue && (
              <p className="text-sm text-warning font-medium">
                ⚠️ Die Rechnung könnte dadurch wieder überfällig werden.
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="flex-1 px-4 py-2 bg-error text-white rounded-lg hover:bg-error/90 disabled:opacity-50 transition-colors duration-150 ease-out font-medium"
          >
            {isPending ? 'Wird aufgehoben...' : 'Ja, aufheben'}
          </button>
          <button
            onClick={onCancel}
            disabled={isPending}
            className="flex-1 px-4 py-2 bg-canvas text-foreground rounded-lg hover:bg-surface-muted transition-colors duration-150 ease-out font-medium"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
};
