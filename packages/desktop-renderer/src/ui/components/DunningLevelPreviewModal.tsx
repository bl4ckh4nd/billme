import { X } from 'lucide-react';
import { useId } from 'react';
import { Avatar, Button, IconButton, Modal } from '@billme/ui';

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
      className="flex max-h-[84vh] max-w-4xl flex-col overflow-hidden"
    >
      <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-title text-foreground">
            E-Mail Vorschau – Mahnstufe {levelNumber}
          </h2>
          <p className="text-caption text-muted">
            Beispielhafte Darstellung im E-Mail-Client
          </p>
          {hasSampleIdentity ? (
            <p className="text-caption text-muted">
              Absender und Empfänger sind Beispielwerte.
            </p>
          ) : null}
        </div>
        <IconButton aria-label="Dialog schließen" tooltip={false} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4.5 pt-1 pb-4">
        {/* Email preview */}
        <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-card border border-border">
          <div className="border-b border-border bg-surface-muted px-3.5 py-3">
            <div className="text-eyebrow uppercase text-muted">Betreff</div>
            <div className="text-section text-foreground">{previewSubject || '(Kein Betreff)'}</div>
          </div>

          <div className="border-b border-border bg-surface px-3.5 py-3">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <Avatar name={senderName} />
                <div>
                  <div className="text-control font-semibold text-foreground">{senderName}</div>
                  <div className="text-caption text-muted">{senderEmail}</div>
                </div>
              </div>
              <div className="text-caption text-muted">
                {new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}
              </div>
            </div>
            <div className="text-caption text-muted">
              <span className="font-medium">An: </span>
              {recipientName} &lt;{recipientEmail}&gt;
            </div>
          </div>

          {/* Email body */}
          <div className="bg-surface px-3.5 py-6" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            <div className="space-y-4">
              {previewText.split('\n').map((paragraph, idx) => (
                <p key={idx} className="text-base leading-relaxed text-foreground">
                  {paragraph || '\u00A0'}
                </p>
              ))}
            </div>

            <div className="mt-8 border-t border-border pt-6">
              <p className="text-sm text-foreground">Mit freundlichen Grüßen</p>
              <p className="mt-2 text-sm font-semibold text-foreground">{senderName}</p>
              <div className="mt-3 space-y-0.5 text-caption text-muted">
                <p>{senderStreet}</p>
                <p>{senderCity}</p>
                <p className="mt-2">
                  Tel: {senderPhone} | {senderEmail} | {senderWebsite}
                </p>
              </div>
            </div>
          </div>

          <div className="border-t border-border bg-surface-muted px-3.5 py-3">
            <p className="text-caption text-muted">
              Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht auf diese Nachricht.
            </p>
          </div>
        </div>

        {/* Placeholder reference */}
        <div className="mx-auto w-full max-w-3xl rounded-control border border-info-border bg-info-bg px-3 py-2.5 text-control text-info-text">
          <div className="mb-1.5 font-semibold">Verwendete Platzhalter:</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <div><code className="font-mono font-semibold">%N</code> = RE-2024-001</div>
            <div><code className="font-mono font-semibold">%D</code> = 15.01.2024</div>
            <div><code className="font-mono font-semibold">%A</code> = 1.250,00 €</div>
            <div><code className="font-mono font-semibold">%C</code> = {recipientName}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
        <Button variant="secondary" onClick={onClose}>Schließen</Button>
      </div>
    </Modal>
  );
};
