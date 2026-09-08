import React from 'react';
import { TemplateDesigner, type DocumentTemplate, type LegalRule } from '@billme/desktop-designer';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '@billme/desktop-core/constants';
import { VARIABLE_GROUPS, renderTextWithPlaceholders } from '@billme/desktop-utils/placeholders';
import { Button, useActionFeedback } from '@billme/ui';
import { useActiveTemplateQuery, useSetActiveTemplateMutation, useUpsertTemplateMutation } from '../hooks/useTemplates';

const commonRules: LegalRule = (elements) => {
  const issues: string[] = [];
  if (!elements.some((e) => e.label === 'sender_company' || e.content?.includes('GmbH'))) issues.push('Absenderangabe fehlt oder unklar.');
  if (!elements.some((e) => e.label === 'recipient_block')) issues.push('Empfängeradresse fehlt (DIN Feld).');
  if (!elements.some((e) => e.content?.toLowerCase().includes('datum'))) issues.push('Rechnungsdatum fehlt.');
  return issues;
};
const proTaxRule: LegalRule = (elements) => elements.some((e) => e.content?.includes('USt') || e.content?.includes('Steuer'))
  ? [] : ['Steuerhinweis / USt-Ausweis fehlt.'];
const liteTaxRule: LegalRule = (elements) => elements.some((e) => ['{{total.tax}}', '{{total.taxRate}}', '{{total.gross}}', '{{invoice.taxExemptionReason}}', '{{invoice.taxModeLabel}}', 'USt', 'Steuer'].some((token) => e.content?.includes(token)))
  ? [] : ['Steuerblock fehlt (z.B. {{total.tax}} oder {{invoice.taxExemptionReason}}).'];
const legalRules = { lite: [commonRules, liteTaxRule], pro: [commonRules, proTaxRule] };

export interface TemplateEditorProps {
  product: 'lite' | 'pro';
  onBack: () => void;
  templateType?: 'invoice' | 'offer';
}

export const TemplateEditor: React.FC<TemplateEditorProps> = ({ product, onBack, templateType = 'invoice' }) => {
  const { notify } = useActionFeedback('templates');
  const active = useActiveTemplateQuery(templateType);
  const upsert = useUpsertTemplateMutation();
  const activate = useSetActiveTemplateMutation();
  if (active.isPending || active.isError) return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-background text-foreground">
      <p role={active.isError ? 'alert' : 'status'}>{active.isError ? 'Vorlage konnte nicht geladen werden.' : 'Vorlage wird geladen …'}</p>
      {active.isError && <Button onClick={() => void active.refetch()}>Erneut versuchen</Button>}
      <Button variant="ghost" onClick={onBack}>Zurück</Button>
    </div>
  );
  return <TemplateDesigner
    key={`${product}:${templateType}`}
    templateType={templateType}
    onBack={onBack}
    activeTemplate={active.data as DocumentTemplate | null}
    initialTemplate={templateType === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE}
    legalRules={legalRules[product]}
    variableGroups={VARIABLE_GROUPS}
    renderText={renderTextWithPlaceholders}
    saving={upsert.isPending || activate.isPending}
    notify={(message, type = 'success') => notify(type, message)}
    onSave={async ({ id, name, elements }) => {
      const now = new Date().toISOString();
      const saved = await upsert.mutateAsync({
        id, kind: templateType, name, elements,
        createdAt: active.data?.id === id ? active.data.createdAt : now,
        updatedAt: now,
      });
      await activate.mutateAsync({ kind: templateType, templateId: saved.id });
      return saved.id;
    }}
  />;
};
