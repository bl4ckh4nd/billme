import React, { useMemo, useState } from 'react';
import { Copy, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Menu, PageHeader, SegmentedControl, useActionFeedback,
} from '@billme/ui';
import { ScaledFlowPreview } from '@billme/desktop-designer/flow';
import {
  TEMPLATE_KIND_LABELS,
  createDefaultTemplateBody,
  templateKindSchema,
  type DocumentTemplateBody,
  type DocumentTemplateRecord,
  type TemplateKind,
} from '@billme/server-core/domain';
import {
  useDeleteDocumentTemplateMutation,
  useDocumentTemplateDefaultsQuery,
  useDocumentTemplatesQuery,
  useSetDefaultDocumentTemplateMutation,
  useUpsertDocumentTemplateMutation,
} from '../../hooks/useDocumentTemplates';
import { useTemplatePreviewModel } from '../../hooks/useTemplatePreviewModel';
import { SkeletonLoader } from '../components/SkeletonLoader';

const SHORT_KIND_LABELS: Record<TemplateKind, string> = {
  invoice: 'Rechnung',
  offer: 'Angebot',
  order_confirmation: 'Auftragsbestätigung',
  delivery_note: 'Lieferschein',
  credit_note: 'Gutschrift',
  dunning: 'Mahnung',
};

const THUMB_WIDTH = 196;

const dateFormatter = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

const Thumbnail: React.FC<{ kind: TemplateKind; body: DocumentTemplateBody }> = ({ kind, body }) => {
  const model = useTemplatePreviewModel(kind, body);
  return (
    <div className="flex justify-center rounded-control bg-surface-sunken px-4 pt-4" aria-hidden="true">
      <ScaledFlowPreview model={model} width={THUMB_WIDTH} firstPageOnly className="rounded-t-sm shadow-sm" />
    </div>
  );
};

type CardProps = {
  kind: TemplateKind;
  title: string;
  subtitle: string;
  body: DocumentTemplateBody;
  isDefault: boolean;
  onOpen: () => void;
  menu?: React.ReactNode;
};

const TemplateCard: React.FC<CardProps> = ({ kind, title, subtitle, body, isDefault, onOpen, menu }) => (
  <article>
    <Card padding="sm" className="flex h-full flex-col gap-3 transition-colors hover:border-control-border-hover">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Vorlage ${title} öffnen`}
        className="relative rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <Thumbnail kind={kind} body={body} />
        {isDefault ? <span className="absolute left-2 top-2"><Badge tone="accent">Standard</Badge></span> : null}
      </button>
      <div className="flex items-start gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold text-foreground" title={title}>{title}</h3>
          <p className="line-clamp-2 text-caption text-muted">{subtitle}</p>
        </div>
        {menu}
      </div>
    </Card>
  </article>
);

export interface TemplatesViewProps {
  onOpenTemplate: (id: string) => void;
  onCreateTemplate: (kind: TemplateKind) => void;
}

export const TemplatesView: React.FC<TemplatesViewProps> = ({ onOpenTemplate, onCreateTemplate }) => {
  const [kind, setKind] = useState<TemplateKind>('invoice');
  const [pendingDelete, setPendingDelete] = useState<DocumentTemplateRecord | null>(null);
  const { notify } = useActionFeedback('templates');
  const templatesQuery = useDocumentTemplatesQuery();
  const defaultsQuery = useDocumentTemplateDefaultsQuery();
  const upsert = useUpsertDocumentTemplateMutation();
  const remove = useDeleteDocumentTemplateMutation();
  const setDefault = useSetDefaultDocumentTemplateMutation();

  const templates = useMemo(
    () => (templatesQuery.data ?? [])
      .filter((template) => template.kind === kind)
      .sort((left, right) => left.name.localeCompare(right.name, 'de-DE')),
    [kind, templatesQuery.data],
  );
  const defaultId = defaultsQuery.data?.[kind] ?? null;
  const presetBody = useMemo(() => createDefaultTemplateBody(kind), [kind]);

  const duplicate = async (template: DocumentTemplateRecord) => {
    try {
      const saved = await upsert.mutateAsync({ kind: template.kind, name: `${template.name} (Kopie)`, body: template.body });
      notify('success', `„${saved.name}“ angelegt.`);
    } catch (error) {
      notify('error', `Duplizieren fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const makeDefault = async (templateId: string | null) => {
    try {
      await setDefault.mutateAsync({ kind, templateId });
      notify('success', templateId ? `Standard für ${TEMPLATE_KIND_LABELS[kind]} gesetzt.` : 'Mitgelieferte Vorlage ist wieder Standard.');
    } catch (error) {
      notify('error', `Standard setzen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await remove.mutateAsync(target.id);
      notify('success', `„${target.name}“ gelöscht.`);
    } catch (error) {
      notify('error', `Löschen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const tabs = (
    <SegmentedControl
      aria-label="Belegart"
      value={kind}
      onChange={setKind}
      options={templateKindSchema.options.map((value) => ({ value, label: SHORT_KIND_LABELS[value] }))}
    />
  );

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Vorlagen"
        description="Wie deine Belege aussehen. Je Belegart gibt es eine Standardvorlage, einzelne Belege können eine andere wählen."
        toolbar={tabs}
        actions={(
          <Button variant="primary" onClick={() => onCreateTemplate(kind)}>
            <Plus size={16} aria-hidden="true" /> Neue Vorlage
          </Button>
        )}
      />

      {templatesQuery.isError || defaultsQuery.isError ? (
        <ErrorState
          title="Vorlagen konnten nicht geladen werden"
          description="Bereits gespeicherte Vorlagen sind nicht verloren. Belege werden bis dahin mit der mitgelieferten Vorlage gedruckt."
          onRetry={() => {
            void templatesQuery.refetch();
            void defaultsQuery.refetch();
          }}
        />
      ) : templatesQuery.isPending || defaultsQuery.isPending ? (
        <SkeletonLoader variant="card" count={4} />
      ) : (
        <section aria-label={`Vorlagen für ${TEMPLATE_KIND_LABELS[kind]}`} className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3.5">
          <TemplateCard
            kind={kind}
            title="Mitgeliefert"
            subtitle={defaultId ? 'Stil Modern, ohne Anpassungen' : 'Gilt, bis du eine eigene Vorlage zum Standard machst'}
            body={presetBody}
            isDefault={!defaultId}
            onOpen={() => onCreateTemplate(kind)}
            menu={defaultId ? (
              <Menu
                aria-label="Aktionen für die mitgelieferte Vorlage"
                align="end"
                trigger={(props) => (
                  <IconButton {...props} size="sm" tooltip="Aktionen" aria-label="Aktionen für die mitgelieferte Vorlage">
                    <MoreHorizontal size={16} aria-hidden="true" />
                  </IconButton>
                )}
                items={[{ id: 'default', label: 'Als Standard verwenden', icon: <Star size={14} />, onSelect: () => void makeDefault(null) }]}
              />
            ) : undefined}
          />
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              kind={kind}
              title={template.name}
              subtitle={`Version ${template.version} · ${dateFormatter.format(new Date(template.updatedAt))}`}
              body={template.body}
              isDefault={template.id === defaultId}
              onOpen={() => onOpenTemplate(template.id)}
              menu={(
                <Menu
                  aria-label={`Aktionen für ${template.name}`}
                  align="end"
                  trigger={(props) => (
                    <IconButton {...props} size="sm" tooltip="Aktionen" aria-label={`Aktionen für ${template.name}`}>
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </IconButton>
                  )}
                  items={[
                    { id: 'edit', label: 'Bearbeiten', icon: <Pencil size={14} />, onSelect: () => onOpenTemplate(template.id) },
                    { id: 'default', label: 'Als Standard verwenden', icon: <Star size={14} />, disabled: template.id === defaultId, onSelect: () => void makeDefault(template.id) },
                    { id: 'duplicate', label: 'Duplizieren', icon: <Copy size={14} />, onSelect: () => void duplicate(template) },
                    { id: 'delete', label: 'Löschen', icon: <Trash2 size={14} />, tone: 'danger', separated: true, onSelect: () => setPendingDelete(template) },
                  ]}
                />
              )}
            />
          ))}
          {templates.length === 0 ? (
            <EmptyState
              className="col-span-full sm:col-span-1"
              title={`Noch keine eigene Vorlage für ${TEMPLATE_KIND_LABELS[kind]}`}
              description="Lege eine an, um Farbe, Logo, Texte und Spalten anzupassen."
            />
          ) : null}
        </section>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`„${pendingDelete?.name ?? ''}“ löschen?`}
        description="Bereits ausgestellte Belege behalten ihr Aussehen. Belege, die diese Vorlage gewählt haben, verwenden danach den Standard."
        confirmLabel="Vorlage löschen"
        cancelLabel="Abbrechen"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};
