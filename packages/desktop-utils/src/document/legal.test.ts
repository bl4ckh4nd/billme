import { describe, expect, it } from 'vitest';
import { createDefaultTemplateBody, templateKindSchema } from '@billme/server-core/domain';
import { templateLegalIssues } from './legal';

describe('templateLegalIssues', () => {
  it('finds nothing to object to in the shipped defaults', () => {
    for (const kind of templateKindSchema.options) {
      expect(templateLegalIssues(kind, createDefaultTemplateBody(kind)), kind).toEqual([]);
    }
  });

  it('flags an invoice without totals, tax number and service date', () => {
    const body = createDefaultTemplateBody('invoice');
    body.sections.totals = { visible: false };
    body.texts.footerColumns = ['{{my.name}}'];
    body.texts.meta = body.texts.meta.filter((entry) => !entry.value.includes('servicePeriod'));
    expect(templateLegalIssues('invoice', body)).toEqual([
      'Der Summenblock ist ausgeblendet. Eine Rechnung muss Entgelt und Steuerbetrag zeigen.',
      'Steuernummer oder USt-IdNr. fehlen (§ 14 Abs. 4 UStG).',
      'Das Leistungsdatum fehlt in den Kopfangaben (§ 14 Abs. 4 UStG).',
    ]);
  });
});
