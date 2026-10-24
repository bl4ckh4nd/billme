import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { LiteVatReport } from '@billme/server-core';

const decimal = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const cell = (value: string | number) => {
  const text = String(value);
  return `"${(typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
};
export const exportLiteVatCsv = (report: LiteVatReport): string => {
  const rows: Array<Array<string | number>> = [
    ['Umsatzsteuer-Vorbereitung', report.from, report.to, report.method, report.preparationComplete ? 'Prüfung vollständig' : 'Prüfung offen', 'Keine ELSTER-Übermittlung'],
    ['Datenstand', report.generatedAt, report.sourceHash],
    ['Umsatzsteuer EUR', decimal(report.outputVatCents), 'Vorsteuer EUR', decimal(report.inputVatCents), 'Zahllast EUR', decimal(report.payableCents)],
    ['Kz 39 Sondervorauszahlung EUR', decimal(report.specialPrepaymentCents ?? 0), 'Kz 83 verbleibende Vorauszahlung/Überschuss EUR', decimal(report.remainingCents ?? report.payableCents)],
    ['Kennziffer Basis', 'Kennziffer Steuer', 'Bezeichnung', 'Richtung', 'Bemessungsgrundlage EUR', 'Bemessungsgrundlage volle EUR', 'Steuer EUR'],
    ...report.positions.map((position) => [position.code, position.taxCode ?? (position.direction === 'input' ? position.code : ''), position.label, position.direction, decimal(position.basisCents), position.basisWholeEuros, decimal(position.taxCents)]),
    ['Zahlungen EUR', decimal(report.reconciliation.paymentCashCents), 'Zuordenbar EUR', decimal(report.reconciliation.paymentRecognizedCents), 'Rest EUR', decimal(report.reconciliation.paymentResidualCents)],
    ['Quelle', 'Quell-ID', 'Beleg', 'Steuerdatum', 'Kennziffer Basis', 'Kennziffer Steuer', 'Steuersatz', 'Netto EUR', 'Steuer EUR'],
    ...report.sources.map((source) => [source.sourceType, source.sourceId, source.label, source.date, source.code, source.taxCode ?? (source.direction === 'input' ? source.code : ''), source.rate, decimal(source.basisCents), decimal(source.taxCents)]),
    ['Prüfcode', 'Quell-ID', 'Prüfhinweis'],
    ...report.issues.map((issue) => [issue.code, issue.sourceId ?? '', issue.message]),
  ];
  return `\ufeff${rows.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
};

export const exportLiteVatPdf = async (report: LiteVatReport): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const text = (value: string) => value.replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue').replaceAll('Ä', 'Ae').replaceAll('Ö', 'Oe').replaceAll('Ü', 'Ue').replaceAll('ß', 'ss').replaceAll('€', 'EUR').replace(/[^\x20-\x7e]/g, '?');
  let page = pdf.addPage([595.28, 841.89]); let y = 792;
  const line = (value: string, strong = false, size = 10) => {
    if (y < 55) { page = pdf.addPage([595.28, 841.89]); y = 792; }
    page.drawText(text(value), { x: 42, y, size, font: strong ? bold : font }); y -= size + 8;
  };
  const wrapped = (value: string) => {
    const words = text(value).split(/\s+/); let current = '';
    for (const word of words) { if (font.widthOfTextAtSize(`${current} ${word}`, 10) > 510 && current) { line(current); current = word; } else current += `${current ? ' ' : ''}${word}`; }
    if (current) line(current);
  };
  line('Umsatzsteuer-Vorbereitung', true, 18);
  line(`${report.from} bis ${report.to} | ${report.method === 'ist' ? 'Ist-Versteuerung' : 'Soll-Versteuerung'}`);
  line(report.preparationComplete ? 'Pruefung vollstaendig' : 'Pruefung offen - vor Verwendung Hinweise klaeren', true);
  line('Keine ELSTER-Uebermittlung. Bezeichnungen und Quelldetails siehe CSV.');
  line(`Umsatzsteuer: ${decimal(report.outputVatCents)} EUR | Vorsteuer: ${decimal(report.inputVatCents)} EUR`);
  line(`Zahllast / Erstattung: ${decimal(report.payableCents)} EUR`, true);
  if (report.specialPrepaymentCents) line(`Kz 39 Sondervorauszahlung: ${decimal(report.specialPrepaymentCents)} EUR`);
  line(`Kz 83 verbleibende Vorauszahlung / Ueberschuss: ${decimal(report.remainingCents ?? report.payableCents)} EUR`, true);
  for (const position of report.positions) {
    wrapped(`${position.code}${position.taxCode ? ` / Steuer ${position.taxCode}` : ''}: ${position.label}`);
    line(`Netto ${decimal(position.basisCents)} EUR (Formular: ${position.basisWholeEuros} EUR), Steuer ${decimal(position.taxCents)} EUR`);
  }
  line('Zahlungsabstimmung', true);
  line(`Zahlungen ${decimal(report.reconciliation.paymentCashCents)} EUR, zuordenbar ${decimal(report.reconciliation.paymentRecognizedCents)} EUR, Rest ${decimal(report.reconciliation.paymentResidualCents)} EUR`);
  line('Pruefhinweise', true);
  if (!report.issues.length) line('Keine offenen Hinweise aus den erfassten Daten.');
  for (const issue of report.issues) wrapped(`${issue.sourceId ?? ''} ${issue.message}`);
  line(`Datenstand: ${report.generatedAt}`, false, 8); wrapped(`Datenpruefsumme: ${report.sourceHash}`);
  pdf.setTitle(`Umsatzsteuer-Vorbereitung ${report.from} - ${report.to}`);
  pdf.setSubject(`Datenpruefsumme ${report.sourceHash}`);
  return pdf.save();
};
