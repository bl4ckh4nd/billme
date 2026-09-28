import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, ImagePlus, Paintbrush, Plus, Save, Trash2 } from 'lucide-react';
import {
  Badge, Button, ConfirmDialog, ErrorState, IconButton, Input, SegmentedControl, Switch, Textarea, useActionFeedback,
} from '@billme/ui';
import { Spinner } from '../ui/components/Spinner';
import { ScaledFlowPreview } from '@billme/desktop-designer/flow';
import {
  PRICE_COLUMNS,
  TEMPLATE_KIND_LABELS,
  TEMPLATE_PRESETS,
  createDefaultTemplateBody,
  templateKindSchema,
  type DocumentTemplateBody,
  type TemplateKind,
  type TemplateSectionId,
} from '@billme/server-core/domain';
import { templateLegalIssues } from '@billme/desktop-utils/document';
import { VARIABLE_GROUPS } from '@billme/desktop-utils/placeholders';
import {
  useDocumentTemplateDefaultsQuery,
  useDocumentTemplatesQuery,
  useSetDefaultDocumentTemplateMutation,
  useUpsertDocumentTemplateMutation,
  type DocumentTemplateDraft,
} from '../hooks/useDocumentTemplates';
import { useTemplatePreviewModel } from '../hooks/useTemplatePreviewModel';

const MAX_LOGO_DATA_URL = 200_000;

const SECTION_LABELS: Record<TemplateSectionId, string> = {
  letterhead: 'Briefkopf mit Logo oder Firmenname',
  addressBlock: 'Anschrift mit Absenderzeile',
  meta: 'Kopfangaben (Nummer, Datum …)',
  title: 'Überschrift',
  intro: 'Einleitung',
  items: 'Positionen',
  totals: 'Summen',
  closing: 'Schlusstext',
  footer: 'Fußzeile',
};

type TextTarget = { element: HTMLInputElement | HTMLTextAreaElement; apply: (value: string) => void };

const Section: React.FC<{ title: string; children: React.ReactNode; action?: React.ReactNode }> = ({ title, children, action }) => (
  <section className="border-b border-border px-5 py-5">
    <div className="mb-3 flex items-center gap-2">
      <h2 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {action}
    </div>
    <div className="flex flex-col gap-3">{children}</div>
  </section>
);

export interface TemplateEditorProps {
  /** A stored template id, or `new` to start from the preset. */
  templateId: string;
  /** Kind of a new template. */
  kind?: TemplateKind;
  onBack: () => void;
  /** Called after the first save of a new template, so the route can point at it. */
  onCreated?: (id: string) => void;
}

export const TemplateEditor: React.FC<TemplateEditorProps> = ({ templateId, kind = 'invoice', onBack, onCreated }) => {
  const templatesQuery = useDocumentTemplatesQuery();
  const defaultsQuery = useDocumentTemplateDefaultsQuery();
  const isNew = templateId === 'new';

  const initial = useMemo<DocumentTemplateDraft | null>(() => {
    if (isNew) {
      return {
        kind,
        name: `${TEMPLATE_KIND_LABELS[kind]} ${new Date().toLocaleDateString('de-DE')}`,
        body: createDefaultTemplateBody(kind),
      };
    }
    const record = templatesQuery.data?.find((template) => template.id === templateId);
    return record ? { id: record.id, kind: record.kind, name: record.name, body: record.body } : null;
    // Only the identity matters: a refetch after saving must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, kind, templateId, Boolean(templatesQuery.data)]);

  if (templatesQuery.isError || defaultsQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8">
        <ErrorState
          title="Vorlage konnte nicht geladen werden"
          description="Die gespeicherten Vorlagen sind gerade nicht abrufbar."
          onRetry={() => {
            void templatesQuery.refetch();
            void defaultsQuery.refetch();
          }}
        />
        <Button variant="ghost" onClick={onBack}>Zurück zu den Vorlagen</Button>
      </div>
    );
  }
  if (templatesQuery.isPending || defaultsQuery.isPending) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-muted">
        <Spinner size="md" />
        <p role="status" className="text-sm font-medium">Vorlage wird geladen …</p>
      </div>
    );
  }
  if (!initial) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8">
        <ErrorState title="Vorlage nicht gefunden" description="Sie wurde vermutlich gelöscht." />
        <Button variant="ghost" onClick={onBack}>Zurück zu den Vorlagen</Button>
      </div>
    );
  }
  return (
    <TemplateEditorForm
      key={initial.id ?? `new-${initial.kind}`}
      initial={initial}
      isDefault={Boolean(initial.id) && defaultsQuery.data?.[initial.kind] === initial.id}
      onBack={onBack}
      onCreated={onCreated}
    />
  );
};

const TemplateEditorForm: React.FC<{
  initial: DocumentTemplateDraft;
  isDefault: boolean;
  onBack: () => void;
  onCreated?: (id: string) => void;
}> = ({ initial, isDefault: initialDefault, onBack, onCreated }) => {
  const { notify } = useActionFeedback('templates');
  const upsert = useUpsertDocumentTemplateMutation();
  const setDefault = useSetDefaultDocumentTemplateMutation();
  const { data: allTemplates = [] } = useDocumentTemplatesQuery();
  const { data: defaults = {} } = useDocumentTemplateDefaultsQuery();

  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [makeDefault, setMakeDefault] = useState(initialDefault);
  const [savedDefault, setSavedDefault] = useState(initialDefault);
  const [longSample, setLongSample] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [confirmApplyAll, setConfirmApplyAll] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(560);
  const [pageCount, setPageCount] = useState(1);
  const previewRef = useRef<HTMLDivElement>(null);
  const textTarget = useRef<TextTarget | null>(null);

  const { kind, body } = draft;
  const dirty = draft !== baseline || makeDefault !== savedDefault;
  const model = useTemplatePreviewModel(kind, body, { longItems: longSample });
  const issues = useMemo(() => templateLegalIssues(kind, body), [kind, body]);
  const priceLocked = kind === 'delivery_note';

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPreviewWidth(Math.max(280, Math.min(760, entry.contentRect.width - 64)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The defaults query may still be refetching when the form mounts after a save.
  const savedDefaultRef = useRef(savedDefault);
  savedDefaultRef.current = savedDefault;
  useEffect(() => {
    setMakeDefault((current) => (current === savedDefaultRef.current ? initialDefault : current));
    setSavedDefault(initialDefault);
  }, [initialDefault]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const setBody = (update: (previous: DocumentTemplateBody) => DocumentTemplateBody) =>
    setDraft((previous) => ({ ...previous, body: update(previous.body) }));
  const setTexts = (patch: Partial<DocumentTemplateBody['texts']>) =>
    setBody((previous) => ({ ...previous, texts: { ...previous.texts, ...patch } }));

  const textField = (apply: (value: string) => void) => ({
    onFocus: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      textTarget.current = { element: event.currentTarget, apply };
    },
  });

  const insertPlaceholder = (key: string) => {
    const target = textTarget.current;
    if (!target) {
      notify('info', 'Setze zuerst den Cursor in ein Textfeld.');
      return;
    }
    const { element, apply } = target;
    const token = `{{${key}}}`;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    apply(`${element.value.slice(0, start)}${token}${element.value.slice(end)}`);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const readLogo = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      if (!dataUrl.startsWith('data:image/')) {
        setLogoError('Diese Datei ist kein Bild.');
        return;
      }
      if (dataUrl.length > MAX_LOGO_DATA_URL) {
        setLogoError('Das Logo ist zu groß. Bitte eine Datei unter 140 KB wählen, z. B. als SVG oder verkleinertes PNG.');
        return;
      }
      setLogoError(null);
      setBody((previous) => ({ ...previous, logo: { dataUrl, position: previous.logo?.position ?? 'right', widthMm: previous.logo?.widthMm ?? 45 } }));
    };
    reader.readAsDataURL(file);
  };

  const save = async () => {
    try {
      const saved = await upsert.mutateAsync(draft);
      if (makeDefault !== savedDefault || (makeDefault && !draft.id)) {
        await setDefault.mutateAsync({ kind, templateId: makeDefault ? saved.id : null });
      }
      const next = { id: saved.id, kind: saved.kind, name: saved.name, body: saved.body };
      setBaseline(next);
      setDraft(next);
      setSavedDefault(makeDefault);
      notify('success', `„${saved.name}“ gespeichert (Version ${saved.version}).`);
      if (!draft.id) onCreated?.(saved.id);
    } catch (error) {
      notify('error', `Speichern fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyDesignToAllKinds = async () => {
    setConfirmApplyAll(false);
    const design = {
      presetId: body.presetId,
      accentColor: body.accentColor,
      font: body.font,
      logo: body.logo,
      din: body.din,
    };
    try {
      for (const other of templateKindSchema.options.filter((candidate) => candidate !== kind)) {
        const defaultId = defaults[other];
        const target = allTemplates.find((template) => template.id === defaultId && template.kind === other);
        const base = target?.body ?? createDefaultTemplateBody(other, body.presetId);
        const saved = await upsert.mutateAsync({
          id: target?.id,
          kind: other,
          name: target?.name ?? `${TEMPLATE_KIND_LABELS[other]} – ${draft.name}`,
          body: {
            ...base,
            ...design,
            texts: { ...base.texts, senderLine: body.texts.senderLine, footerColumns: body.texts.footerColumns },
          },
        });
        if (!target) await setDefault.mutateAsync({ kind: other, templateId: saved.id });
      }
      notify('success', 'Design auf alle Belegarten übertragen.');
    } catch (error) {
      notify('error', `Übertragen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const busy = upsert.isPending || setDefault.isPending;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-4">
        <Button variant="ghost" size="sm" onClick={() => (dirty ? setConfirmDiscard(true) : onBack())}>
          <ArrowLeft size={16} aria-hidden="true" /> Vorlagen
        </Button>
        <div className="h-6 border-l border-border" />
        <input
          value={draft.name}
          onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
          aria-label="Name der Vorlage"
          className="min-w-0 flex-1 rounded-control border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-foreground hover:border-control-border focus-visible:border-control-border focus-visible:outline-2 focus-visible:outline-focus-ring"
        />
        <Badge tone="neutral">{TEMPLATE_KIND_LABELS[kind]}</Badge>
        {dirty ? (
          <span className="hidden items-center gap-1 text-xs font-semibold text-warning-text md:flex">
            <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />Ungespeichert
          </span>
        ) : null}
        <Button variant="secondary" size="sm" onClick={() => setConfirmApplyAll(true)} disabled={busy}>
          <Paintbrush size={14} aria-hidden="true" /> Auf alle Arten übertragen
        </Button>
        <Button variant="primary" size="sm" onClick={() => void save()} loading={busy} disabled={!draft.name.trim()}>
          <Save size={14} aria-hidden="true" /> Speichern
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[400px] shrink-0 overflow-y-auto border-r border-border bg-surface" aria-label="Vorlage bearbeiten">
          <Section title="Verwendung">
            <Switch
              checked={makeDefault}
              onCheckedChange={setMakeDefault}
              label={`Standard für ${TEMPLATE_KIND_LABELS[kind]}`}
              description="Neue Belege dieser Art verwenden die Vorlage, solange sie keine andere wählen."
            />
          </Section>

          <Section title="Design">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Stil">
              {TEMPLATE_PRESETS.map((preset) => {
                const selected = body.presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setBody((previous) => ({ ...previous, presetId: preset.id, accentColor: preset.accentColor, font: preset.font }))}
                    className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${selected ? 'border-foreground bg-surface-muted' : 'border-border hover:border-control-border-hover'}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <span className="size-3 rounded-full" style={{ background: preset.accentColor }} aria-hidden="true" />
                      {preset.label}
                    </span>
                    <span className="text-xs text-muted">{preset.description}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-end gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Akzentfarbe
                <input
                  type="color"
                  value={body.accentColor}
                  onChange={(event) => setBody((previous) => ({ ...previous, accentColor: event.target.value }))}
                  aria-label="Akzentfarbe"
                  className="h-10 w-14 cursor-pointer rounded-control border border-control-border bg-surface p-1"
                />
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Schrift</span>
                <SegmentedControl
                  aria-label="Schrift"
                  value={body.font}
                  onChange={(font) => setBody((previous) => ({ ...previous, font }))}
                  options={[{ value: 'inter', label: 'Sans (Inter)' }, { value: 'serif', label: 'Serif' }]}
                />
              </div>
            </div>
          </Section>

          <Section title="Logo">
            {body.logo ? (
              <>
                <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted p-3">
                  <img src={body.logo.dataUrl} alt="Logo" className="max-h-12 max-w-40 object-contain" />
                  <div className="flex-1" />
                  <IconButton size="sm" tooltip="Logo entfernen" aria-label="Logo entfernen" onClick={() => setBody((previous) => ({ ...previous, logo: null }))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </IconButton>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Position</span>
                  <SegmentedControl
                    aria-label="Position des Logos"
                    value={body.logo.position}
                    onChange={(position) => setBody((previous) => (previous.logo ? { ...previous, logo: { ...previous.logo, position } } : previous))}
                    options={[{ value: 'left', label: 'Links' }, { value: 'center', label: 'Mitte' }, { value: 'right', label: 'Rechts' }]}
                  />
                </div>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Breite: {body.logo.widthMm} mm
                  <input
                    type="range"
                    min={15}
                    max={80}
                    value={body.logo.widthMm}
                    aria-label="Breite des Logos in Millimetern"
                    onChange={(event) => {
                      const widthMm = Number(event.target.value);
                      setBody((previous) => (previous.logo ? { ...previous, logo: { ...previous.logo, widthMm } } : previous));
                    }}
                  />
                </label>
              </>
            ) : (
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-control-border p-4 text-sm font-medium text-muted hover:border-foreground hover:text-foreground focus-within:outline-2 focus-within:outline-focus-ring">
                <ImagePlus size={16} aria-hidden="true" /> Logo hochladen (PNG, JPG oder SVG)
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  className="sr-only"
                  aria-label="Logo hochladen"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) readLogo(file);
                    event.target.value = '';
                  }}
                />
              </label>
            )}
            {logoError ? <p className="text-xs text-error-text" role="alert">{logoError}</p> : null}
          </Section>

          <Section
            title="Texte"
            action={(
              <select
                aria-label="Platzhalter einfügen"
                value=""
                onChange={(event) => {
                  if (event.target.value) insertPlaceholder(event.target.value);
                }}
                className="h-8 max-w-44 rounded-control border border-control-border bg-surface px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-focus-ring"
              >
                <option value="">Platzhalter einfügen …</option>
                {VARIABLE_GROUPS.map((group) => (
                  <optgroup key={group.title} label={group.title}>
                    {group.variables.map((variable) => <option key={variable.key} value={variable.key}>{variable.label}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
          >
            <Input
              label="Überschrift"
              value={body.texts.title}
              onChange={(event) => setTexts({ title: event.target.value })}
              {...textField((title) => setTexts({ title }))}
            />
            <Textarea
              label="Einleitung"
              rows={4}
              value={body.texts.intro}
              onChange={(event) => setTexts({ intro: event.target.value })}
              {...textField((intro) => setTexts({ intro }))}
            />
            <Textarea
              label="Schlusstext"
              rows={5}
              value={body.texts.closing}
              onChange={(event) => setTexts({ closing: event.target.value })}
              {...textField((closing) => setTexts({ closing }))}
            />
            <Input
              label="Absenderzeile über der Anschrift"
              value={body.texts.senderLine}
              onChange={(event) => setTexts({ senderLine: event.target.value })}
              {...textField((senderLine) => setTexts({ senderLine }))}
            />
          </Section>

          <Section
            title="Kopfangaben"
            action={body.texts.meta.length < 10 ? (
              <Button variant="ghost" size="sm" onClick={() => setTexts({ meta: [...body.texts.meta, { label: '', value: '' }] })}>
                <Plus size={14} aria-hidden="true" /> Zeile
              </Button>
            ) : undefined}
          >
            <p className="text-xs text-muted">Zeilen, deren Platzhalter leer bleiben, werden nicht gedruckt.</p>
            {body.texts.meta.map((entry, index) => {
              const setEntry = (patch: Partial<typeof entry>) =>
                setTexts({ meta: body.texts.meta.map((candidate, position) => (position === index ? { ...candidate, ...patch } : candidate)) });
              return (
                <div key={index} className="flex items-center gap-2">
                  <input
                    value={entry.label}
                    onChange={(event) => setEntry({ label: event.target.value })}
                    {...textField((label) => setEntry({ label }))}
                    aria-label={`Bezeichnung Kopfangabe ${index + 1}`}
                    className="h-9 w-32 min-w-0 rounded-control border border-control-border bg-surface px-2 text-sm focus-visible:outline-2 focus-visible:outline-focus-ring"
                  />
                  <input
                    value={entry.value}
                    onChange={(event) => setEntry({ value: event.target.value })}
                    {...textField((value) => setEntry({ value }))}
                    aria-label={`Wert Kopfangabe ${index + 1}`}
                    className="h-9 min-w-0 flex-1 rounded-control border border-control-border bg-surface px-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-focus-ring"
                  />
                  <IconButton size="sm" tooltip="Zeile entfernen" aria-label={`Kopfangabe ${index + 1} entfernen`} onClick={() => setTexts({ meta: body.texts.meta.filter((_, position) => position !== index) })}>
                    <Trash2 size={14} aria-hidden="true" />
                  </IconButton>
                </div>
              );
            })}
          </Section>

          <Section
            title="Fußzeile"
            action={body.texts.footerColumns.length < 4 ? (
              <Button variant="ghost" size="sm" onClick={() => setTexts({ footerColumns: [...body.texts.footerColumns, ''] })}>
                <Plus size={14} aria-hidden="true" /> Spalte
              </Button>
            ) : undefined}
          >
            {body.texts.footerColumns.map((column, index) => (
              <div key={index} className="flex items-start gap-2">
                <Textarea
                  aria-label={`Fußzeile Spalte ${index + 1}`}
                  rows={3}
                  value={column}
                  fullWidth
                  onChange={(event) => setTexts({ footerColumns: body.texts.footerColumns.map((candidate, position) => (position === index ? event.target.value : candidate)) })}
                  {...textField((value) => setTexts({ footerColumns: body.texts.footerColumns.map((candidate, position) => (position === index ? value : candidate)) }))}
                  className="font-mono text-xs"
                />
                <IconButton size="sm" tooltip="Spalte entfernen" aria-label={`Fußzeile Spalte ${index + 1} entfernen`} onClick={() => setTexts({ footerColumns: body.texts.footerColumns.filter((_, position) => position !== index) })}>
                  <Trash2 size={14} aria-hidden="true" />
                </IconButton>
              </div>
            ))}
          </Section>

          <Section title="Abschnitte">
            {(Object.keys(SECTION_LABELS) as TemplateSectionId[]).map((section) => {
              const locked = priceLocked && section === 'totals';
              return (
                <Switch
                  key={section}
                  checked={!locked && body.sections[section]?.visible !== false}
                  disabled={locked}
                  onCheckedChange={(visible) => setBody((previous) => ({ ...previous, sections: { ...previous.sections, [section]: { visible } } }))}
                  label={SECTION_LABELS[section]}
                  description={locked ? 'Ein Lieferschein zeigt keine Beträge.' : undefined}
                />
              );
            })}
          </Section>

          <Section title="Spalten der Positionen">
            {body.columns.map((column, index) => {
              const locked = priceLocked && PRICE_COLUMNS.includes(column.id);
              const setColumn = (patch: Partial<typeof column>) =>
                setBody((previous) => ({ ...previous, columns: previous.columns.map((candidate, position) => (position === index ? { ...candidate, ...patch } : candidate)) }));
              return (
                <div key={column.id} className="flex items-center gap-3">
                  <Switch
                    checked={!locked && column.visible}
                    disabled={locked}
                    onCheckedChange={(visible) => setColumn({ visible })}
                    aria-label={`Spalte ${column.label} anzeigen`}
                  />
                  <input
                    value={column.label}
                    maxLength={40}
                    disabled={locked}
                    onChange={(event) => setColumn({ label: event.target.value })}
                    aria-label={`Überschrift der Spalte ${index + 1}`}
                    className="h-9 min-w-0 flex-1 rounded-control border border-control-border bg-surface px-2 text-sm disabled:text-disabled-foreground focus-visible:outline-2 focus-visible:outline-focus-ring"
                  />
                </div>
              );
            })}
            {priceLocked ? <p className="text-xs text-muted">Preisspalten sind auf dem Lieferschein immer ausgeblendet.</p> : null}
          </Section>

          <Section title="Falz- und Lochmarken">
            <Switch
              checked={body.din.foldMarks}
              onCheckedChange={(foldMarks) => setBody((previous) => ({ ...previous, din: { ...previous.din, foldMarks } }))}
              label="Falzmarken (DIN 5008)"
            />
            <Switch
              checked={body.din.holeMark}
              onCheckedChange={(holeMark) => setBody((previous) => ({ ...previous, din: { ...previous.din, holeMark } }))}
              label="Lochmarke"
            />
          </Section>

          <Section title="Prüfung">
            {issues.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-success-text"><CheckCircle2 size={16} aria-hidden="true" /> Alle Pflichtangaben sind enthalten.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Hinweise zur Vorlage">
                {issues.map((issue) => (
                  <li key={issue} className="flex gap-2 text-sm text-warning-text">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{issue}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>

        <main ref={previewRef} className="flex min-w-0 flex-1 flex-col overflow-auto bg-surface-sunken" aria-label="Vorschau">
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-surface-sunken/95 px-6 py-2 backdrop-blur">
            <SegmentedControl
              aria-label="Beispielbeleg"
              size="sm"
              value={longSample ? 'long' : 'short'}
              onChange={(value) => setLongSample(value === 'long')}
              options={[{ value: 'short', label: 'Kurzer Beleg' }, { value: 'long', label: '40 Positionen' }]}
            />
            <span className="text-xs text-muted" role="status">{pageCount} {pageCount === 1 ? 'Seite' : 'Seiten'} · so wird gedruckt</span>
          </div>
          <div className="flex justify-center px-8 py-8" data-testid="template-preview">
            <ScaledFlowPreview model={model} width={previewWidth} onReady={setPageCount} />
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={confirmApplyAll}
        title="Design auf alle Belegarten übertragen?"
        description="Stil, Akzentfarbe, Schrift, Logo, Absenderzeile, Fußzeile und Marken werden in die Standardvorlagen der anderen Belegarten übernommen. Wo es noch keine gibt, wird eine angelegt. Texte der einzelnen Arten bleiben unverändert."
        confirmLabel="Übertragen"
        cancelLabel="Abbrechen"
        onConfirm={() => void applyDesignToAllKinds()}
        onCancel={() => setConfirmApplyAll(false)}
      />
      <ConfirmDialog
        open={confirmDiscard}
        title="Ungespeicherte Änderungen verwerfen?"
        description="Deine Änderungen an dieser Vorlage gehen verloren."
        confirmLabel="Verwerfen"
        cancelLabel="Weiter bearbeiten"
        destructive
        onConfirm={() => {
          setConfirmDiscard(false);
          onBack();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
};
