import { describe, expect, it } from 'vitest';
import { documentTemplateBodySchema, migrateCanvasTemplate, type LegacyCanvasElement } from '@billme/server-core/domain';
import { createDefaultTemplateBody } from './presets';

// Texts of the retired canvas defaults (INITIAL_INVOICE_TEMPLATE / INITIAL_OFFER_TEMPLATE), as stored in old databases.
const text = (label: string, content: string): LegacyCanvasElement => ({ type: 'TEXT', x: 75, label, content, style: {} });
const INITIAL_INVOICE_TEMPLATE: LegacyCanvasElement[] = [
  text('sender_company', '{{my.name}}'),
  text('recipient_block', '{{client.company}}\n{{client.address}}'),
  text('invoice_title', '{{invoice.documentLabel}} {{invoice.number}}'),
  text('intro_text', 'Guten Tag,\n\nvielen Dank für Ihren Auftrag. Hier finden Sie die Rechnung für unsere Leistungen:'),
  { type: 'TABLE', x: 75, label: 'items_table', style: {} },
  text('payment_terms', 'Bitte überweisen Sie den Betrag bis spätestens {{invoice.dueDate}} ohne Abzug auf das unten genannte Konto.\nEs gelten unsere AGB.'),
  text('footer_bank', 'Bankverbindung:\nIBAN: {{my.iban}}\nBIC: {{my.bic}}'),
];
const INITIAL_OFFER_TEMPLATE: LegacyCanvasElement[] = INITIAL_INVOICE_TEMPLATE.map((element) => {
  if (element.label === 'invoice_title') return { ...element, content: 'Angebot {{invoice.number}}' };
  if (element.label === 'intro_text') return { ...element, content: 'Guten Tag,\n\nhier ist unser freibleibendes Angebot für die angefragten Leistungen:' };
  if (element.label === 'payment_terms') return { ...element, content: 'Wenn Sie das Angebot annehmen möchten oder Fragen haben, melden Sie sich bitte.' };
  return element;
});

describe('migrateCanvasTemplate', () => {
  it('turns the shipped canvas defaults into the preset default', () => {
    expect(migrateCanvasTemplate('invoice', INITIAL_INVOICE_TEMPLATE)).toEqual(createDefaultTemplateBody('invoice'));
    expect(migrateCanvasTemplate('offer', INITIAL_OFFER_TEMPLATE)).toEqual(createDefaultTemplateBody('offer'));
  });

  it('keeps edited texts and a logo, and the result is a valid body', () => {
    const edited = INITIAL_INVOICE_TEMPLATE.map((element) =>
      element.label === 'payment_terms' ? { ...element, content: 'Zahlbar sofort.' } : element);
    const logo: LegacyCanvasElement = { type: 'IMAGE', x: 40, src: 'data:image/png;base64,AAAA', style: { width: 400 } };
    const body = migrateCanvasTemplate('invoice', [...edited, logo]);
    expect(body.texts.closing).toBe('Zahlbar sofort.');
    expect(body.texts.intro).toBe(createDefaultTemplateBody('invoice').texts.intro);
    expect(body.logo).toEqual({ dataUrl: 'data:image/png;base64,AAAA', position: 'left', widthMm: 80 });
    expect(documentTemplateBodySchema.safeParse(body).success).toBe(true);
  });

  it('drops logos that are not inline images', () => {
    const remote: LegacyCanvasElement = { type: 'IMAGE', x: 600, src: 'https://example.com/logo.png', style: {} };
    expect(migrateCanvasTemplate('invoice', [remote]).logo).toBeNull();
  });
});
