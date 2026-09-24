import { X } from 'lucide-react';
import { useId } from 'react';
import { Modal } from '@billme/ui';

export interface DunningPreviewSender {
  name?: string;
  email?: string;
  street?: string;
  zip?: string;
  city?: string;
  phone?: string;
  website?: string;
}

export interface DunningPreviewRecipient {
  name?: string;
  email?: string;
}

interface DunningLevelPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  subject: string;
  text: string;
  levelNumber: number;
  /** Absenderdaten aus den Einstellungen. Fehlende Angaben erscheinen als Beispielwerte. */
  sender?: DunningPreviewSender;
  /** Empfängerdaten der konkreten Rechnung, sofern beim Aufruf bekannt. */
  recipient?: DunningPreviewRecipient;
}

const SAMPLE_COMPANY = 'Beispiel GmbH';
const SAMPLE_EMAIL = 'beispiel@example.com';
const SAMPLE_STREET = 'Beispielstrasse 1';
const SAMPLE_CITY = '12345 Beispielstadt';
const SAMPLE_PHONE = '+49 000 000000';
const SAMPLE_WEBSITE = 'www.beispiel.de';

export const DunningLevelPreviewModal = ({
  isOpen,
  onClose,
  subject,
  text,
  levelNumber,
  sender,
  recipient,
}: DunningLevelPreviewModalProps) => {
  const titleId = useId();

  if (!isOpen) return null;

  const senderName = sender?.name?.trim() || 'Ihre Firma';
  const senderEmail = sender?.email?.trim() || SAMPLE_EMAIL;
  const senderStreet = sender?.street?.trim() || SAMPLE_STREET;
  const senderCity = [sender?.zip?.trim(), sender?.city?.trim()].filter(Boolean).join(' ') || SAMPLE_CITY;
  const senderPhone = sender?.phone?.trim() || SAMPLE_PHONE;
  const senderWebsite = sender?.website?.trim() || SAMPLE_WEBSITE;
  const recipientName = recipient?.name?.trim() || SAMPLE_COMPANY;
  const recipientEmail = recipient?.email?.trim() || SAMPLE_EMAIL;
  const hasSampleIdentity = !sender?.name?.trim() || !recipient?.name?.trim();
  const senderInitials = senderName.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase()).join('') || 'IF';

  const previewText = text
    .replace(/%N/g, 'RE-2024-001')
    .replace(/%D/g, '15.01.2024')
    .replace(/%A/g, '1.250,00 €')
    .replace(/%C/g, recipientName);

  const previewSubject = subject
    .replace(/%N/g, 'RE-2024-001')
    .replace(/%D/g, '15.01.2024')
    .replace(/%A/g, '1.250,00 €')
    .replace(/%C/g, recipientName);

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      titleId={titleId}
      className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface-muted px-6 py-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            E-Mail Vorschau – Mahnstufe {levelNumber}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Beispielhafte Darstellung im E-Mail-Client
          </p>
          {hasSampleIdentity ? (
            <p className="mt-0.5 text-xs text-muted">
              Absender und Empfänger sind Beispielwerte.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dialog schließen"
          onClick={onClose}
          className="rounded-lg p-2 text-muted transition-colors hover:bg-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-surface-sunken p-8">
        {/* Email preview */}
        <div className="mx-auto max-w-3xl overflow-hidden rounded-lg shadow-xl">
          {/* Email header */}
          <div className="border-b border-border bg-surface-muted px-6 py-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Betreff</div>
            <div className="text-base font-semibold text-foreground">{previewSubject || '(Kein Betreff)'}</div>
          </div>

          {/* Email metadata */}
          <div className="border-b border-border-subtle bg-surface px-6 py-4">
            <div className="mb-3 flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-sm font-semibold text-foreground">
                  {senderInitials}
                </div>
                <div>
                  <div className="text-sm font-semibold text-foreground">{senderName}</div>
                  <div className="text-xs text-muted">{senderEmail}</div>
                </div>
              </div>
              <div className="text-xs text-muted">
                {new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}
              </div>
            </div>
            <div className="text-xs text-muted">
              <span className="font-medium">An: </span>
              {recipientName} &lt;{recipientEmail}&gt;
            </div>
          </div>

          {/* Email body */}
          <div className="bg-surface px-6 py-8" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            <div className="space-y-4">
              {previewText.split('\n').map((paragraph, idx) => (
                <p key={idx} className="text-base leading-relaxed text-foreground">
                  {paragraph || '\u00A0'}
                </p>
              ))}
            </div>

            {/* Signature */}
            <div className="mt-8 border-t border-border pt-6">
              <p className="text-sm text-foreground">Mit freundlichen Grüßen</p>
              <p className="mt-2 text-sm font-semibold text-foreground">{senderName}</p>
              <div className="mt-3 space-y-0.5 text-xs text-muted">
                <p>{senderStreet}</p>
                <p>{senderCity}</p>
                <p className="mt-2">
                  Tel: {senderPhone} | {senderEmail} | {senderWebsite}
                </p>
              </div>
            </div>
          </div>

          {/* Email footer */}
          <div className="border-t border-border bg-surface-muted px-6 py-3">
            <p className="text-xs leading-tight text-muted">
              Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht auf diese Nachricht.
            </p>
          </div>
        </div>

        {/* Placeholder reference */}
        <div className="mx-auto mt-6 max-w-3xl rounded-lg border border-info-border bg-info-bg p-4">
          <div className="mb-2 text-xs font-semibold text-info-text">Verwendete Platzhalter:</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-baseline gap-2">
              <code className="rounded-sm bg-info-bg px-1.5 py-1 font-mono font-semibold text-info-text">%N</code>
              <span className="text-info-text">= RE-2024-001</span>
            </div>
            <div className="flex items-baseline gap-2">
              <code className="rounded-sm bg-info-bg px-1.5 py-1 font-mono font-semibold text-info-text">%D</code>
              <span className="text-info-text">= 15.01.2024</span>
            </div>
            <div className="flex items-baseline gap-2">
              <code className="rounded-sm bg-info-bg px-1.5 py-1 font-mono font-semibold text-info-text">%A</code>
              <span className="text-info-text">= 1.250,00 €</span>
            </div>
            <div className="flex items-baseline gap-2">
              <code className="rounded-sm bg-info-bg px-1.5 py-1 font-mono font-semibold text-info-text">%C</code>
              <span className="text-info-text">= {recipientName}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 border-t border-border bg-surface-muted px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-dark-base px-6 py-2.5 text-sm font-semibold text-background shadow-sm transition-colors hover:bg-dark-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
        >
          Schließen
        </button>
      </div>
    </Modal>
  );
};
