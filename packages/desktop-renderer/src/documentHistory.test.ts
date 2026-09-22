import { describe, expect, it } from 'vitest';
import { formatDocumentHistoryAction } from './documentHistory';

describe('formatDocumentHistoryAction', () => {
  it.each([
    ['invoice.create (create)', 'Erstellt'],
    ['invoice.update (email_sent)', 'Per E-Mail versendet'],
    ['invoice.update (invoice_finalize)', 'Festgeschrieben'],
    ['invoice.update (Notiz: Kunde ruft (Montag) zurück)', 'Notiz: Kunde ruft (Montag) zurück'],
    ['invoice.update (Adresse korrigiert (finalisiert))', 'Geändert · Adresse korrigiert (finalisiert)'],
    ['invoice.dunning_reminder_sent (Mahnstufe 2)', 'Mahnung per E-Mail versendet · Mahnstufe 2'],
    ['invoice.create (Converted from offer ANG-2026-001)', 'Erstellt · aus Angebot ANG-2026-001 übernommen'],
    ['offer.portal_token_reserved (Reserve bearer token before portal publication)', 'Portal-Link vorbereitet'],
    ['offer.publish', 'Im Kundenportal veröffentlicht'],
  ])('%s → %s', (raw, expected) => {
    expect(formatDocumentHistoryAction(raw)).toBe(expected);
  });

  it('leaves prose entries and unknown actions untouched', () => {
    expect(formatDocumentHistoryAction('Per E-Mail gesendet an a@b.de')).toBe('Per E-Mail gesendet an a@b.de');
    expect(formatDocumentHistoryAction('invoice.something_new (x)')).toBe('invoice.something_new (x)');
  });
});
