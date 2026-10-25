import React, { useEffect, useId, useMemo, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Button, ErrorState, IconButton, Modal, Select, useActionFeedback } from '@billme/ui';
import { ScaledFlowPreview } from '@billme/desktop-designer/flow';
import { buildDocumentViewModel, type DocumentRenderInput } from '@billme/desktop-utils/document';
import type { DunningLevel } from '@billme/desktop-core/types';
import { useDocumentRenderContextQuery } from '../../hooks/useDocuments';
import { ipc } from '../../runtime-api';
import { Spinner } from './Spinner';

const PREVIEW_WIDTH = 520;

const LetterPreview: React.FC<{ invoiceId: string; level: number }> = ({ invoiceId, level }) => {
  const query = useDocumentRenderContextQuery('dunning', invoiceId, level);
  const context = query.data;
  const model = useMemo(() => {
    if (!context?.settings) return null;
    return buildDocumentViewModel({
      kind: context.templateKind,
      template: context.template.body,
      document: context.document as DocumentRenderInput['document'],
      settings: context.settings as DocumentRenderInput['settings'],
      texts: context.texts,
      source: context.source,
      dunning: context.dunning,
    });
  }, [context]);

  if (query.isError) {
    return <ErrorState title="Mahnschreiben konnte nicht geladen werden" description={query.error instanceof Error ? query.error.message : String(query.error)} onRetry={() => void query.refetch()} />;
  }
  if (!model) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-muted">
        <Spinner size="sm" label={null} />
        <span role="status" className="text-control">Mahnschreiben wird vorbereitet …</span>
      </div>
    );
  }
  return (
    <div data-testid="dunning-letter-preview" data-theme="light" className="mx-auto">
      <ScaledFlowPreview model={model} width={PREVIEW_WIDTH} className="rounded-sm shadow-sm" />
    </div>
  );
};

/** The printed dunning letter of one invoice for any configured level: preview and PDF. */
export const DunningLetterModal: React.FC<{
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  invoiceNumber: string;
  levels: DunningLevel[];
  initialLevel: number;
}> = ({ open, onClose, invoiceId, invoiceNumber, levels, initialLevel }) => {
  const titleId = useId();
  const { notify } = useActionFeedback('documents');
  const [level, setLevel] = useState(initialLevel);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { if (open) setLevel(initialLevel); }, [open, initialLevel]);

  const exportPdf = async () => {
    setExporting(true);
    try {
      const result = await ipc.pdf.export({ kind: 'dunning', id: invoiceId, level });
      notify('success', 'PDF gespeichert', { action: { label: 'Öffnen', onClick: () => void ipc.shell.openPath({ path: result.path }) } });
    } catch (error) {
      notify('error', `PDF konnte nicht erstellt werden: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} titleId={titleId} className="flex max-h-[90vh] w-[min(600px,95vw)] flex-col overflow-hidden">
      <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-title text-foreground">Mahnschreiben</h3>
          <p className="text-caption text-muted">Zur Rechnung {invoiceNumber}, so wie es gedruckt und per E-Mail versendet wird.</p>
        </div>
        <IconButton aria-label="Dialog schließen" tooltip={false} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="px-4.5 pb-3">
        <Select label="Mahnstufe" value={String(level)} onChange={(event) => setLevel(Number(event.target.value))} className="w-60">
          {levels.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
          ))}
        </Select>
      </div>
      <div className="flex-1 overflow-y-auto border-y border-border bg-surface-muted p-3.5">
        {open && <LetterPreview invoiceId={invoiceId} level={level} />}
      </div>
      <div className="flex flex-wrap justify-end gap-2 px-4.5 py-3">
        <Button variant="secondary" onClick={onClose}>Schließen</Button>
        <Button onClick={() => void exportPdf()} loading={exporting}>
          <Download size={16} aria-hidden="true" /> PDF erstellen
        </Button>
      </div>
    </Modal>
  );
};
