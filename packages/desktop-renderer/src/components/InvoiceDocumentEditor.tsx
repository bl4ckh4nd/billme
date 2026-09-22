import React, { useEffect, useState } from 'react';
import { DocumentEditor } from '@billme/desktop-designer/document-editor';
import type {
  ArticleLike,
  ClientLike,
  DocumentDraft,
  ProjectLike,
  SettingsLike,
} from '@billme/desktop-designer/document-editor';
import { ErrorState } from '@billme/ui';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '@billme/desktop-core/constants';
import { useArticlesQuery } from '../hooks/useArticles';
import { useClientsQuery } from '../hooks/useClients';
import { useProjectsQuery } from '../hooks/useProjects';
import { useSettingsQuery } from '../hooks/useSettings';
import { useActiveTemplateQuery } from '../hooks/useTemplates';
import { getRendererRuntime } from '../runtime-api';
import type { Invoice } from '@billme/desktop-core/types';

interface InvoiceDocumentEditorProps {
  invoice: Invoice;
  templateType?: 'invoice' | 'offer';
  mode?: 'create' | 'edit';
  onSave: (invoice: Invoice) => void;
  onCancel: () => void;
}

export const InvoiceDocumentEditor: React.FC<InvoiceDocumentEditorProps> = ({
  invoice,
  templateType = 'invoice',
  mode = 'edit',
  onSave,
  onCancel,
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
  const { data: activeTemplate } = useActiveTemplateQuery(templateType);
  const { data: projects = [] } = useProjectsQuery(
    selectedClientId ? { clientId: selectedClientId, includeArchived: false } : undefined,
  );
  const runtime = getRendererRuntime();

  // The document renders the company's own legal and bank identity through the
  // {{my.*}} placeholders, so it must never be built from stand-in data.
  if (settingsIsError) {
    return (
      <div className="flex min-h-full items-center justify-center bg-background p-8">
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
      <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-background text-muted">
        <Spinner size="md" />
        <p role="status" className="text-sm font-medium">Firmendaten werden geladen …</p>
      </div>
    );
  }

  // ponytail: no onTemplateElementsChange, so template texts stay read-only in a document.
  // Editing them here silently rewrote the global template for every later document.
  // Replace once DocumentDraft carries its own intro/outro/payment-terms fields.
  return (
    <DocumentEditor
      document={invoice as unknown as DocumentDraft}
      templateType={templateType}
      mode={mode}
      clients={clients as unknown as ClientLike[]}
      articles={articles as unknown as ArticleLike[]}
      projects={projects as unknown as ProjectLike[]}
      settings={settings as unknown as SettingsLike}
      templateElements={activeTemplate?.elements ?? (templateType === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE)}
      onValidateVatId={runtime.validateVatId}
      onSelectedClientChange={setSelectedClientId}
      onSave={(document) => onSave(document as unknown as Invoice)}
      onCancel={onCancel}
    />
  );
};
