import React from 'react';
import { TemplateDesigner, type LegalRule } from '@billme/desktop-designer';
import type { DocumentTemplate, InvoiceElement } from '../types';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '../constants';
import { VARIABLE_GROUPS, renderTextWithPlaceholders } from '../utils/placeholders';
import {
  useActiveTemplateQuery,
  useSetActiveTemplateMutation,
  useUpsertTemplateMutation,
} from '../hooks/useTemplates';
import { useToast } from '../hooks/useToast';
import { Toast } from './Toast';

interface InvoiceEditorProps {
  onBack: () => void;
  templateType?: 'invoice' | 'offer';
}

// DIN 5008 / GoBD mandatory-field hints (Lite includes richer tax-placeholder checks).
const LITE_LEGAL_RULES: LegalRule[] = [
  (els) =>
    els.some((e) => e.label === 'sender_company' || (e.content?.includes('GmbH') ?? false))
      ? []
      : ['Absenderangabe fehlt oder unklar.'],
  (els) => (els.some((e) => e.label === 'recipient_block') ? [] : ['Empfängeradresse fehlt (DIN Feld).']),
  (els) =>
    els.some((e) => e.content?.toLowerCase().includes('datum') ?? false) ? [] : ['Rechnungsdatum fehlt.'],
  (els) => {
    const hasAmount = els.some(
      (e) =>
        e.content &&
        (e.content.includes('{{total.tax}}') ||
          e.content.includes('{{total.taxRate}}') ||
          e.content.includes('{{total.gross}}')),
    );
    const hasReason = els.some(
      (e) =>
        e.content &&
        (e.content.includes('{{invoice.taxExemptionReason}}') || e.content.includes('{{invoice.taxModeLabel}}')),
    );
    const hasKeyword = els.some((e) => e.content && (e.content.includes('USt') || e.content.includes('Steuer')));
    return hasAmount || hasReason || hasKeyword
      ? []
      : ['Steuerblock fehlt (z.B. {{total.tax}} oder {{invoice.taxExemptionReason}}).'];
  },
];

export const InvoiceEditor: React.FC<InvoiceEditorProps> = ({ onBack, templateType = 'invoice' }) => {
  const { data: activeTemplate } = useActiveTemplateQuery(templateType);
  const upsert = useUpsertTemplateMutation();
  const setActive = useSetActiveTemplateMutation();
  const { toast, toastState, closeToast } = useToast();

  const initialTemplate = templateType === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE;

  return (
    <>
      <TemplateDesigner
        templateType={templateType}
        onBack={onBack}
        activeTemplate={
          activeTemplate
            ? { id: activeTemplate.id, name: activeTemplate.name, elements: activeTemplate.elements as InvoiceElement[] }
            : null
        }
        initialTemplate={initialTemplate}
        legalRules={LITE_LEGAL_RULES}
        variableGroups={VARIABLE_GROUPS}
        renderText={renderTextWithPlaceholders}
        saving={upsert.isPending || setActive.isPending}
        notify={(message, type) =>
          toast({ title: message, variant: type === 'error' ? 'destructive' : 'success' })
        }
        onSave={async ({ id, name, elements, mode: _mode }) => {
          const now = new Date().toISOString();
          const payload: DocumentTemplate = {
            id,
            kind: templateType,
            name,
            elements,
            createdAt: now,
            updatedAt: now,
          };
          const saved = await upsert.mutateAsync(payload);
          await setActive.mutateAsync({ kind: templateType, templateId: saved.id });
          return saved.id;
        }}
      />
      <Toast
        message={toastState.message}
        type={toastState.type}
        isVisible={toastState.isVisible}
        onClose={closeToast}
      />
    </>
  );
};
