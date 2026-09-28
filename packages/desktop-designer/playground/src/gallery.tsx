import React from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentFlowPages } from '@billme/desktop-designer/flow';
import {
  TEMPLATE_PRESETS,
  buildDocumentViewModel,
  createDefaultTemplateBody,
  sampleRenderInput,
} from '@billme/desktop-utils/document';
import { TEMPLATE_KIND_LABELS, templateKindSchema, templatePresetIdSchema, type TemplateKind, type TemplatePresetId } from '@billme/server-core/domain';

// Gallery for the flow-layout templates: one document per URL so a script can
// print every kind x preset to PDF. ?kind=invoice&preset=modern&items=40&logo=1

const SAMPLE_LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="90" viewBox="0 0 360 90"><rect x="4" y="13" width="64" height="64" rx="10" fill="#6b4f2a"/><path d="M20 62 L36 26 L52 62 Z" fill="#f3e7d3"/><text x="84" y="55" font-family="Georgia, serif" font-size="34" fill="#2b2118">Holzwerk Brandt</text></svg>',
)}`;

const params = new URLSearchParams(location.search);
const kind = templateKindSchema.catch('invoice').parse(params.get('kind')) as TemplateKind;
const preset = templatePresetIdSchema.catch('modern').parse(params.get('preset')) as TemplatePresetId;
const longItems = params.get('items') === '40';
const withLogo = params.get('logo') === '1';
const tax = (['small_business', 'reverse_charge', 'mixed'] as const).find((value) => value === params.get('tax'));

declare global {
  interface Window {
    __GALLERY_READY__?: boolean;
    __GALLERY_PAGES__?: number;
  }
}

const App = () => {
  const model = React.useMemo(() => {
    const template = createDefaultTemplateBody(kind, preset);
    if (withLogo) template.logo = { dataUrl: SAMPLE_LOGO, position: preset === 'klassisch' ? 'right' : 'left', widthMm: 58 };
    return buildDocumentViewModel({ ...sampleRenderInput(kind, { longItems, tax }), template });
  }, []);
  const link = (next: Record<string, string>) => `?${new URLSearchParams({ kind, preset, ...(longItems ? { items: '40' } : {}), ...(withLogo ? { logo: '1' } : {}), ...(tax ? { tax } : {}), ...next })}`;
  return (
    <main className="gallery-shell">
      <nav className="gallery-nav">
        {templateKindSchema.options.map((value) => (
          <a key={value} href={link({ kind: value })} aria-current={value === kind ? 'page' : undefined}>{TEMPLATE_KIND_LABELS[value]}</a>
        ))}
        <span className="gallery-sep" />
        {TEMPLATE_PRESETS.map((entry) => (
          <a key={entry.id} href={link({ preset: entry.id })} aria-current={entry.id === preset ? 'page' : undefined}>{entry.label}</a>
        ))}
      </nav>
      <DocumentFlowPages
        model={model}
        pageClassName="gallery-page"
        onReady={(pages) => {
          window.__GALLERY_PAGES__ = pages;
          window.__GALLERY_READY__ = true;
        }}
      />
    </main>
  );
};

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #e9eae6; font-family: system-ui, sans-serif; }
  .gallery-shell { padding: 16px 0 40px; }
  .gallery-nav { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin: 0 auto 16px; max-width: 900px; }
  .gallery-nav a { padding: 5px 10px; border-radius: 999px; background: #fff; color: #333; text-decoration: none; font-size: 13px; border: 1px solid #d3d5cf; }
  .gallery-nav a[aria-current] { background: #1d1f22; color: #fff; border-color: #1d1f22; }
  .gallery-sep { width: 16px; }
  .gallery-page { margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.06); }
  @media print {
    @page { size: A4; margin: 0; }
    body { background: #fff; }
    .gallery-shell { padding: 0; }
    .gallery-nav { display: none; }
    .gallery-page { margin: 0; box-shadow: none; }
  }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
