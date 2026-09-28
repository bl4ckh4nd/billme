import React from 'react';
import { DocumentFlowPages } from '@billme/desktop-designer/flow';
import { buildDocumentViewModel, type DocumentRenderInput } from '@billme/desktop-utils/document';
import { useDocumentRenderContextQuery } from '../hooks/useDocuments';

type PdfReadyGlobal = { __PDF_READY__?: boolean; __PDF_ERROR__?: string; __PDF_PAGES__?: number };

const PageNotice: React.FC<{ title: string; detail?: string }> = ({ title, detail }) => (
  <div id="print-page" style={{ width: '210mm', height: '297mm', background: 'white' }}>
    <div style={{ padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>{title}</h1>
      {detail ? <p style={{ marginTop: 8, color: '#676d75' }}>{detail}</p> : null}
    </div>
  </div>
);

export const PrintDocument: React.FC<{ kind: 'invoice' | 'offer' | 'dunning'; id: string; level?: number }> = ({ kind, id, level }) => {
  const contextQuery = useDocumentRenderContextQuery(kind, id, level);
  const context = contextQuery.data;

  // The printed page carries the company's own legal and bank identity, so it is
  // rendered from the stored settings only: no stand-in company ever reaches a PDF.
  const model = React.useMemo(() => {
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

  React.useEffect(() => {
    (globalThis as PdfReadyGlobal).__PDF_READY__ = false;
  }, []);

  // Tell the exporter about a dead end right away instead of letting it time out.
  const printError = contextQuery.isError
    ? `Beleg konnte nicht geladen werden (${kind} / ${id}): ${contextQuery.error instanceof Error ? contextQuery.error.message : String(contextQuery.error)}`
    : context && !context.settings
      ? 'Ohne Firmen- und Bankdaten wird der Beleg nicht gedruckt.'
      : null;
  React.useEffect(() => {
    (globalThis as PdfReadyGlobal).__PDF_ERROR__ = printError ?? undefined;
  }, [printError]);

  // DocumentFlowPages reports after fonts are loaded and the paginated pages painted.
  const handleReady = React.useCallback((pageCount: number) => {
    (globalThis as PdfReadyGlobal).__PDF_PAGES__ = pageCount;
    (globalThis as PdfReadyGlobal).__PDF_READY__ = true;
  }, []);

  return (
    <div>
      <style>{`
        @page { size: A4; margin: 0; }
        html, body { margin: 0; padding: 0; background: white; }
        #root { height: auto !important; }
      `}</style>

      {printError ? (
        <PageNotice title="Beleg kann nicht gedruckt werden" detail={printError} />
      ) : !model ? (
        <PageNotice title="Beleg wird vorbereitet" />
      ) : (
        <DocumentFlowPages model={model} onReady={handleReady} />
      )}
    </div>
  );
};
