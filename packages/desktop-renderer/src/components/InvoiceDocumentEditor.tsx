import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DocumentEditor } from '@billme/desktop-designer/document-editor';
import type {
  ArticleLike,
  ClientLike,
  DocumentDraft,
  ProjectLike,
  SettingsLike,
} from '@billme/desktop-designer/document-editor';
import { ErrorState } from '@billme/ui';
import { Spinner } from '../ui/components/Spinner';
import { SHIPPED_TEMPLATE_ID, TEMPLATE_KIND_LABELS, resolveDocumentTemplate, templateKindForDocument } from '@billme/server-core/domain';
import { useArticlesQuery } from '../hooks/useArticles';
import { useClientsQuery } from '../hooks/useClients';
import { useProjectsQuery } from '../hooks/useProjects';
import { useSettingsQuery } from '../hooks/useSettings';
import { useDocumentTemplateDefaultsQuery, useDocumentTemplatesQuery } from '../hooks/useDocumentTemplates';
import { getRendererRuntime } from '../runtime-api';
import type { Invoice, Offer } from '@billme/desktop-core/types';

interface InvoiceDocumentEditorProps {
  invoice: Invoice | Offer;
  templateType?: 'invoice' | 'offer';
  mode?: 'create' | 'edit';
  onSave: (invoice: Invoice | Offer, meta?: { numberChangeReason?: string }) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export const InvoiceDocumentEditor: React.FC<InvoiceDocumentEditorProps> = ({
  invoice,
  templateType = 'invoice',
  mode = 'edit',
  onSave,
  onCancel,
  onDirtyChange,
}) => {
  const [selectedClientId, setSelectedClientId] = useState(invoice.clientId ?? '');
  useEffect(() => {
    setSelectedClientId(invoice.clientId ?? '');
  }, [invoice.clientId, invoice.id]);
  const { data: clients = [] } = useClientsQuery();
  const { data: articles = [] } = useArticlesQuery();
  const {
    data: settings,
    isError: settingsIsError,
    refetch: refetchSettings,
  } = useSettingsQuery();
  const { data: templates = [] } = useDocumentTemplatesQuery();
  const { data: defaults = {} } = useDocumentTemplateDefaultsQuery();
  const templateKind = templateType === 'offer' ? 'offer' : templateKindForDocument({ documentKind: invoice.documentKind });
  const hasDefaultTemplate = templates.some((template) => template.id === defaults[templateKind] && template.kind === templateKind);
  const templateOptions = useMemo(
    () => [
      // Once a default is set, the shipped look stays choosable for a single document.
      ...(hasDefaultTemplate ? [{ id: SHIPPED_TEMPLATE_ID, name: `Mitgeliefert: ${TEMPLATE_KIND_LABELS[templateKind]}` }] : []),
      // The default itself is the "Standard (…)" entry; listing it again would show it twice.
      ...templates.filter((template) => template.kind === templateKind && template.id !== defaults[templateKind]).map(({ id, name }) => ({ id, name })),
    ],
    [defaults, hasDefaultTemplate, templateKind, templates],
  );
  const resolveTemplateBody = useCallback(
    (templateId?: string) => resolveDocumentTemplate(templateKind, { templateId, templates, defaults }).body,
    [defaults, templateKind, templates],
  );
  const defaultTemplateName = templates.find((template) => template.id === defaults[templateKind] && template.kind === templateKind)?.name
    ?? `mitgeliefert: ${TEMPLATE_KIND_LABELS[templateKind]}`;
  const { data: projects = [] } = useProjectsQuery(
    selectedClientId ? { clientId: selectedClientId, includeArchived: false } : undefined,
  );
  const runtime = getRendererRuntime();

  // The document renders the company's own legal and bank identity through the
  // {{my.*}} placeholders, so it must never be built from stand-in data.
  if (settingsIsError) {
    return (
      <div className="flex min-h-full items-center justify-center bg-ground p-5">
        <ErrorState
          title="Firmendaten konnten nicht geladen werden"
          description="Absender, Bankverbindung und Steuernummer stammen aus den Einstellungen. Ohne sie wird das Dokument nicht geöffnet."
          onRetry={() => void refetchSettings()}
        />
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-ground text-muted">
        <Spinner size="md" />
        <p role="status" className="text-control">Firmendaten werden geladen …</p>
      </div>
    );
  }

  return (
    <DocumentEditor
      document={invoice as unknown as DocumentDraft}
      templateType={templateType}
      mode={mode}
      accountingEvidenceRequired={runtime.product === 'pro'}
      clients={clients as unknown as ClientLike[]}
      articles={articles as unknown as ArticleLike[]}
      projects={projects as unknown as ProjectLike[]}
      settings={settings as unknown as SettingsLike}
      templateKind={templateKind}
      templateOptions={templateOptions}
      defaultTemplateName={defaultTemplateName}
      resolveTemplateBody={resolveTemplateBody}
      onValidateVatId={runtime.validateVatId}
      onSelectedClientChange={setSelectedClientId}
      onSave={(document, meta) => onSave(document as unknown as Invoice | Offer, meta)}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
    />
  );
};
