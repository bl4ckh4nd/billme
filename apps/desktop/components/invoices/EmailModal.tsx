import React from 'react';
import { Mail, X, Paperclip, Send } from 'lucide-react';
import { Button } from '@billme/ui';
import { Invoice } from '../../types';

interface EmailData {
  to: string;
  subject: string;
  message: string;
}

interface EmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  emailData: EmailData;
  setEmailData: React.Dispatch<React.SetStateAction<EmailData>>;
  selectedDocument: Invoice | undefined;
  onSend: () => void;
}

export const EmailModal: React.FC<EmailModalProps> = ({
  isOpen,
  onClose,
  emailData,
  setEmailData,
  selectedDocument,
  onSend,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
         <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl flex flex-col animate-scale-in">
            <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-surface-muted rounded-t-3xl">
                <h3 className="text-lg font-black flex items-center gap-2"><Mail size={18}/> Per E-Mail senden</h3>
                <button onClick={onClose} className="p-2 hover:bg-canvas rounded-full transition-colors ease-out duration-150"><X size={18}/></button>
            </div>
            <div className="p-6 space-y-4">
                <div>
                    <label className="block text-xs font-bold text-muted mb-1">Empfänger</label>
                    <input
                        type="email"
                        value={emailData.to}
                        onChange={e => setEmailData({...emailData, to: e.target.value})}
                        className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                    />
                </div>
                <div>
                    <label className="block text-xs font-bold text-muted mb-1">Betreff</label>
                    <input
                        type="text"
                        value={emailData.subject}
                        onChange={e => setEmailData({...emailData, subject: e.target.value})}
                        className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                    />
                </div>
                <div>
                    <label className="block text-xs font-bold text-muted mb-1">Nachricht</label>
                    <textarea
                        rows={6}
                        value={emailData.message}
                        onChange={e => setEmailData({...emailData, message: e.target.value})}
                        className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm focus:ring-2 focus:ring-accent outline-none resize-none"
                    />
                </div>
                <div className="flex items-center gap-2 text-xs text-muted bg-surface-muted p-3 rounded-lg border border-border-subtle">
                    <Paperclip size={14} />
                    <span>Angehängt: {selectedDocument?.number}.pdf</span>
                </div>
            </div>
            <div className="p-6 border-t border-border-subtle bg-surface-muted rounded-b-3xl flex justify-end gap-3">
                <button onClick={onClose} className="px-6 py-3 rounded-xl font-bold text-muted hover:bg-canvas transition-colors ease-out duration-150">Abbrechen</button>
                <Button onClick={onSend} size="md">
                    <Send size={16} /> Senden
                </Button>
            </div>
         </div>
    </div>
  );
};
