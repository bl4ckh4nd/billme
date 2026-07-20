import { X } from 'lucide-react';
import React from 'react';

interface DunningLevelPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  subject: string;
  text: string;
  levelNumber: number;
}

export const DunningLevelPreviewModal = ({
  isOpen,
  onClose,
  subject,
  text,
  levelNumber,
}: DunningLevelPreviewModalProps) => {
  if (!isOpen) return null;

  const previewText = text
    .replace(/%N/g, 'RE-2024-001')
    .replace(/%D/g, '15.01.2024')
    .replace(/%A/g, '1.250,00 €')
    .replace(/%C/g, 'Mustermann GmbH');

  const previewSubject = subject
    .replace(/%N/g, 'RE-2024-001')
    .replace(/%D/g, '15.01.2024')
    .replace(/%A/g, '1.250,00 €')
    .replace(/%C/g, 'Mustermann GmbH');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/60 backdrop-blur-sm">
      <div className="bg-surface rounded-xl shadow-2xl w-[95%] max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-muted">
          <div>
            <h2 className="text-lg font-bold text-foreground">
              E-Mail Vorschau – Mahnstufe {levelNumber}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Beispielhafte Darstellung im E-Mail-Client
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-canvas rounded-lg transition-colors duration-150 ease-out"
          >
            <X size={20} className="text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8 bg-canvas">
          {/* Email Client Window */}
          <div className="bg-surface rounded-lg shadow-xl border border-border overflow-hidden max-w-3xl mx-auto">
            {/* Email Client Header Bar */}
            <div className="bg-gradient-to-b from-surface-muted to-surface border-b border-border px-6 py-3">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-3 h-3 rounded-full bg-error"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                <div className="w-3 h-3 rounded-full bg-success"></div>
              </div>
              <div className="text-xs text-muted uppercase tracking-wider font-semibold mb-1">Betreff</div>
              <div className="text-base font-semibold text-foreground">{previewSubject || '(Kein Betreff)'}</div>
            </div>

            {/* Email Metadata */}
            <div className="px-6 py-4 bg-surface border-b border-border-subtle">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-info to-info/80 flex items-center justify-center text-white font-bold text-sm">
                    IF
                  </div>
                  <div>
                    <div className="font-semibold text-foreground text-sm">Ihre Firma</div>
                    <div className="text-xs text-muted">info@example.com</div>
                  </div>
                </div>
                <div className="text-xs text-muted">
                  {new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}
                </div>
              </div>
              <div className="text-xs text-muted">
                <span className="font-medium text-muted">An: </span>
                Mustermann GmbH &lt;kunde@mustermann.de&gt;
              </div>
            </div>

            {/* Email Body */}
            <div className="px-6 py-8 bg-surface" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
              <div className="space-y-4">
                {previewText.split('\n').map((paragraph, idx) => (
                  <p key={idx} className="text-foreground text-[15px] leading-relaxed">
                    {paragraph || '\u00A0'}
                  </p>
                ))}
              </div>

              {/* Signature */}
              <div className="mt-8 pt-6 border-t border-border">
                <p className="text-muted text-sm">Mit freundlichen Grüßen</p>
                <p className="text-foreground font-semibold text-sm mt-2">Ihre Firma</p>
                <div className="mt-3 text-xs text-muted space-y-0.5">
                  <p>Musterstraße 123</p>
                  <p>12345 Musterstadt</p>
                  <p className="mt-2">
                    Tel: +49 123 456789 | info@example.com | www.example.com
                  </p>
                </div>
              </div>
            </div>

            {/* Email Footer */}
            <div className="px-6 py-3 bg-surface-muted border-t border-border">
              <p className="text-[10px] text-muted leading-tight">
                Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht auf diese Nachricht.
              </p>
            </div>
          </div>

          {/* Placeholder Reference */}
          <div className="mt-6 max-w-3xl mx-auto bg-info-bg border border-info/30 rounded-lg p-4">
            <div className="text-xs text-info font-semibold mb-2">Verwendete Platzhalter:</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-baseline gap-2">
                <code className="bg-info-bg px-1.5 py-1 rounded font-mono font-semibold text-info">%N</code>
                <span className="text-info">= RE-2024-001</span>
              </div>
              <div className="flex items-baseline gap-2">
                <code className="bg-info-bg px-1.5 py-1 rounded font-mono font-semibold text-info">%D</code>
                <span className="text-info">= 15.01.2024</span>
              </div>
              <div className="flex items-baseline gap-2">
                <code className="bg-info-bg px-1.5 py-1 rounded font-mono font-semibold text-info">%A</code>
                <span className="text-info">= 1.250,00 €</span>
              </div>
              <div className="flex items-baseline gap-2">
                <code className="bg-info-bg px-1.5 py-1 rounded font-mono font-semibold text-info">%C</code>
                <span className="text-info">= Mustermann GmbH</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-surface-muted">
          <button
            onClick={onClose}
            className="px-6 py-2.5 bg-foreground text-white rounded-lg hover:bg-dark-1 transition-colors duration-150 ease-out font-semibold text-sm shadow-sm"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
