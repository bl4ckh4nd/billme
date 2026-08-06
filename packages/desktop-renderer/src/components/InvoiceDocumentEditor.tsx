import React, { useEffect, useState } from 'react';
import { DocumentEditor } from '@billme/desktop-designer/document-editor';
import type {
  ArticleLike,
  ClientLike,
  DocumentDraft,
  ProjectLike,
  SettingsLike,
} from '@billme/desktop-designer/document-editor';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '@billme/desktop-core/constants';
import { MOCK_SETTINGS } from '@billme/desktop-services/mockData';
import { useArticlesQuery } from '../hooks/useArticles';
import { useClientsQuery } from '../hooks/useClients';
import { useProjectsQuery } from '../hooks/useProjects';
import { useSettingsQuery } from '../hooks/useSettings';
import { useActiveTemplateQuery } from '../hooks/useTemplates';
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
  const { data: settings } = useSettingsQuery();
  const { data: activeTemplate } = useActiveTemplateQuery(templateType);
  const { data: projects = [] } = useProjectsQuery(
    selectedClientId ? { clientId: selectedClientId, includeArchived: false } : undefined,
  );
  return (
    <DocumentEditor
      document={invoice as unknown as DocumentDraft}
      templateType={templateType}
      mode={mode}
      clients={clients as unknown as ClientLike[]}
      articles={articles as unknown as ArticleLike[]}
      projects={projects as unknown as ProjectLike[]}
      settings={(settings ?? MOCK_SETTINGS) as unknown as SettingsLike}
      templateElements={activeTemplate?.elements ?? (templateType === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE)}
      onSelectedClientChange={setSelectedClientId}
      onSave={(document) => onSave(document as unknown as Invoice)}
      onCancel={onCancel}
    />
  );
};
