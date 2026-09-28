import type { DocumentTemplateBody, TemplateKind } from '@billme/server-core/domain';

const BILLING_KINDS: readonly TemplateKind[] = ['invoice', 'credit_note'];

/**
 * Checks a template against what a German business document must show
 * (§ 14 UStG for invoices, DIN 5008 for window envelopes). Warnings only:
 * a user may knowingly print without them.
 */
export const templateLegalIssues = (kind: TemplateKind, body: DocumentTemplateBody): string[] => {
  const visible = (section: keyof DocumentTemplateBody['sections']) => body.sections[section]?.visible !== false;
  const allText = [
    body.texts.title, body.texts.intro, body.texts.closing, body.texts.senderLine,
    ...body.texts.meta.flatMap((entry) => [entry.label, entry.value]),
    ...(visible('footer') ? body.texts.footerColumns : []),
  ].join('\n');
  const metaText = visible('meta') ? body.texts.meta.map((entry) => entry.value).join('\n') : '';
  const issues: string[] = [];

  if (!visible('addressBlock')) issues.push('Die Empfängeradresse ist ausgeblendet. Im Fensterumschlag fehlt dann die Anschrift.');
  else if (!body.texts.senderLine.trim()) issues.push('Die Absenderzeile über der Anschrift ist leer.');
  if (!/\{\{(invoice|dunning)\.date\}\}/.test(metaText)) issues.push('Das Belegdatum fehlt in den Kopfangaben.');
  if (!/\{\{invoice\.number\}\}/.test(allText)) issues.push('Die Belegnummer erscheint nirgends auf dem Beleg.');
  if (!visible('letterhead') && !/\{\{my\.name\}\}/.test(allText)) issues.push('Der Name deines Unternehmens erscheint nirgends auf dem Beleg.');

  if (BILLING_KINDS.includes(kind)) {
    if (!visible('items')) issues.push('Die Positionen sind ausgeblendet. Eine Rechnung muss Menge und Art der Leistung zeigen.');
    if (!visible('totals')) issues.push('Der Summenblock ist ausgeblendet. Eine Rechnung muss Entgelt und Steuerbetrag zeigen.');
    if (!/\{\{my\.(taxId|vatId)\}\}/.test(allText)) issues.push('Steuernummer oder USt-IdNr. fehlen (§ 14 Abs. 4 UStG).');
    if (kind === 'invoice' && !/\{\{invoice\.servicePeriod\}\}/.test(metaText)) issues.push('Das Leistungsdatum fehlt in den Kopfangaben (§ 14 Abs. 4 UStG).');
  }
  if (kind === 'credit_note' && !/\{\{source\.number\}\}/.test(allText)) issues.push('Der Bezug auf die ursprüngliche Rechnung fehlt.');
  return issues;
};
