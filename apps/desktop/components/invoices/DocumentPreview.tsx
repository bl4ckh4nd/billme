import React from 'react';
import { User, Calendar, Clock } from 'lucide-react';
import { Invoice, InvoiceTaxSnapshot, InvoiceItem } from '../../types';
import { formatCurrency, formatDate } from './helpers';

interface DocumentPreviewProps {
  selectedDocument: Invoice;
  selectedDocumentItems: InvoiceItem[];
  selectedDocumentTax: InvoiceTaxSnapshot | null;
  selectedPaymentTermsText: string;
  documentType: 'invoice' | 'offer';
}

export const DocumentPreview: React.FC<DocumentPreviewProps> = ({
  selectedDocument,
  selectedDocumentItems,
  selectedDocumentTax,
  selectedPaymentTermsText,
  documentType,
}) => {
  return (
    <div className="bg-surface-muted rounded-xl p-8 border border-border-subtle relative overflow-hidden">
      {/* Visual Paper Edge Effect top */}
      <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-b from-border/50 to-transparent opacity-50"></div>

      {/* Meta Header */}
      <div className="flex flex-col md:flex-row justify-between gap-8 mb-10 pb-8 border-b border-border border-dashed">
          <div>
              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                  <User size={12}/> Empfänger
              </p>
              <p className="font-bold text-foreground text-lg">{selectedDocument.client}</p>
              <p className="text-sm text-muted whitespace-pre-line leading-relaxed mt-1">
                  {selectedDocument.clientAddress || selectedDocument.clientEmail}
              </p>
          </div>
          <div className="flex gap-8">
               <div>
                   <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                       <Calendar size={12}/> Datum
                   </p>
                   <p className="font-mono font-bold text-foreground tabular-nums">{formatDate(selectedDocument.date)}</p>
               </div>
               <div>
                   <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                       <Calendar size={12}/> Leistungsdatum
                   </p>
                   <p className="font-mono font-bold text-foreground tabular-nums">{formatDate(selectedDocument.servicePeriod || selectedDocument.date)}</p>
               </div>
               <div>
                   <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                       <Clock size={12}/> {documentType === 'offer' ? 'Gültig bis' : 'Fällig'}
                  </p>
                  <p className={`font-mono font-bold tabular-nums ${selectedDocument.status === 'overdue' ? 'text-error' : 'text-foreground'}`}>
                      {formatDate(selectedDocument.dueDate)}
                  </p>
              </div>
          </div>
      </div>

      {/* Items Table */}
      <div className="mb-8">
          <table className="w-full">
              <thead>
                  <tr className="text-[10px] font-bold text-muted uppercase tracking-wider text-left border-b border-border">
                      <th className="pb-3 pl-2">Beschreibung</th>
                      <th className="pb-3 text-right">Menge</th>
                      <th className="pb-3 text-right">Einzel</th>
                      <th className="pb-3 text-right pr-2">Gesamt</th>
                  </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                  {selectedDocumentItems.map((item, i) => (
                      <tr key={i} className="group hover:bg-surface/50 transition-colors ease-out duration-150">
                          <td className="py-4 pl-2 font-bold text-foreground">{item.description}</td>
                          <td className="py-4 text-right text-muted text-sm tabular-nums">{item.quantity}</td>
                          <td className="py-4 text-right text-muted text-sm tabular-nums">{formatCurrency(item.price)}</td>
                          <td className="py-4 text-right font-bold text-foreground tabular-nums pr-2">{formatCurrency(item.total)}</td>
                      </tr>
                  ))}
              </tbody>
          </table>
      </div>

      {/* Totals & Notes */}
      <div className="flex flex-col md:flex-row justify-between items-start gap-8 border-t border-border border-dashed pt-8">
           <div className="flex-1">
                <p className="text-xs font-bold text-foreground mb-2">Hinweis</p>
                <p className="text-xs text-muted leading-relaxed max-w-sm whitespace-pre-line">
                    {selectedPaymentTermsText}
                </p>
            </div>
           <div className="w-full md:w-64 space-y-2">
               <div className="flex justify-between text-sm text-muted">
                   <span>Netto</span>
                   <span className="tabular-nums">{formatCurrency(selectedDocumentTax?.netAmount ?? 0)}</span>
               </div>
               <div className="flex justify-between text-sm text-muted">
                   <span>USt {(selectedDocumentTax?.vatRateApplied ?? 0)}%</span>
                   <span className="tabular-nums">{formatCurrency(selectedDocumentTax?.vatAmount ?? 0)}</span>
               </div>
               <div className="flex justify-between text-xl font-bold text-foreground border-t border-border pt-3 mt-1">
                   <span>Gesamt</span>
                   <span className="tabular-nums">{formatCurrency(selectedDocumentTax?.grossAmount ?? selectedDocument.amount)}</span>
               </div>
           </div>
      </div>
    </div>
  );
};
