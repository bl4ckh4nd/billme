import React from 'react';
import type { InvoiceElement } from '@billme/desktop-core/types';
import { A4_HEIGHT_PX, A4_WIDTH_PX, INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '@billme/desktop-core/constants';
import { DocumentPages } from '@billme/desktop-designer/DocumentPages';
import { useSettingsQuery } from '../hooks/useSettings';
import { useActiveTemplateQuery } from '../hooks/useTemplates';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useOffersQuery } from '../hooks/useOffers';
import { getPreviewElements } from '@billme/desktop-utils/documentPreview';

type PdfReadyGlobal = { __PDF_READY__?: boolean; __PDF_ERROR__?: string };
type PreviewArgs = Parameters<typeof getPreviewElements>;

const pageStyle: React.CSSProperties = {
  width: `${A4_WIDTH_PX}px`,
  height: `${A4_HEIGHT_PX}px`,
  background: 'white',
  position: 'relative',
  overflow: 'hidden',
};

const PageNotice: React.FC<{ title: string; detail?: string }> = ({ title, detail }) => (
  <div id="print-page" style={pageStyle}>
    <div style={{ padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>{title}</h1>
      {detail ? <p style={{ marginTop: 8, color: '#676d75' }}>{detail}</p> : null}
    </div>
  </div>
);

export const PrintDocument: React.FC<{ kind: 'invoice' | 'offer'; id: string }> = ({ kind, id }) => {
  // The printed page carries the company's own legal and bank identity, so it is
  // rendered from the stored settings only: no stand-in company ever reaches a PDF.
  const settingsQuery = useSettingsQuery();
  const settings = settingsQuery.data;
  const { data: activeTemplate } = useActiveTemplateQuery(kind);
  const template = activeTemplate?.elements ?? (kind === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE);

  const invoicesQuery = useInvoicesQuery();
  const offersQuery = useOffersQuery();
  const doc =
    kind === 'offer'
      ? (offersQuery.data ?? []).find((o) => o.id === id)
      : (invoicesQuery.data ?? []).find((i) => i.id === id);

  const previewElements = React.useMemo(() => {
    if (!doc || !settings) return [];
    return getPreviewElements(
      doc as PreviewArgs[0],
      template as unknown as PreviewArgs[1],
      settings as unknown as PreviewArgs[2],
    ) as unknown as InvoiceElement[];
  }, [doc, template, settings]);

  React.useEffect(() => {
    (globalThis as PdfReadyGlobal).__PDF_READY__ = false;
  }, []);

  // Tell the exporter about a dead end right away instead of letting it time out.
  const documentsQuery = kind === 'offer' ? offersQuery : invoicesQuery;
  const printError = documentsQuery.isError
    ? 'Belege konnten nicht geladen werden.'
    : documentsQuery.isSuccess && !doc
      ? `Dokument nicht gefunden (${kind} / ${id}).`
      : settingsQuery.isError
        ? 'Stammdaten konnten nicht geladen werden.'
        : null;
  React.useEffect(() => {
    (globalThis as PdfReadyGlobal).__PDF_ERROR__ = printError ?? undefined;
  }, [printError]);

  // Ensure layout has painted before printToPDF.
  const handleReady = React.useCallback(() => {
    const fontsReady = typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve();
    Promise.resolve(fontsReady).catch(() => undefined).then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          (globalThis as PdfReadyGlobal).__PDF_READY__ = true;
        });
      });
    });
  }, []);

  return (
    <div>
      <style>{`
        @page { size: A4; margin: 0; }
        html, body { margin: 0; padding: 0; background: white; }
        #root { height: auto !important; }
      `}</style>

      {!doc ? (
        <PageNotice title="Dokument nicht gefunden" detail={`${kind} / ${id}`} />
      ) : settingsQuery.isError ? (
        <PageNotice
          title="Stammdaten konnten nicht geladen werden"
          detail="Ohne Firmen- und Bankdaten wird der Beleg nicht gedruckt. Schließe das Fenster und versuche es erneut."
        />
      ) : !settings ? (
        <PageNotice title="Stammdaten werden geladen" detail="Der Beleg wird gedruckt, sobald die Einstellungen vorliegen." />
      ) : (
        <DocumentPages
          elements={previewElements}
          pageWidth={A4_WIDTH_PX}
          pageHeight={A4_HEIGHT_PX}
          onReady={handleReady}
        />
      )}
    </div>
  );
};
