import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { FACTURX_FILENAME, embedZugferdInPdf } from './embedZugferdInPdf';

const xml = '<?xml version="1.0" encoding="UTF-8"?><rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"/>';

const blankPdf = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return pdf.save();
};

describe('embedZugferdInPdf', () => {
  it('attaches factur-x.xml as associated file with PDF/A-3 and Factur-X metadata', async () => {
    const output = await embedZugferdInPdf({ pdfBytes: await blankPdf(), xml, invoiceNumber: 'RE-2026-001', now: new Date('2026-09-27T10:00:00Z') });
    const pdf = await PDFDocument.load(output);
    const catalog = pdf.catalog;

    const names = catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
    expect((names.lookup(0) as PDFString).decodeText()).toBe(FACTURX_FILENAME);
    const fileSpec = names.lookup(1, PDFDict);
    expect(fileSpec.get(PDFName.of('AFRelationship'))).toEqual(PDFName.of('Alternative'));
    const af = catalog.lookup(PDFName.of('AF'), PDFArray);
    expect(af.size()).toBe(1);
    const embedded = fileSpec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F')) as PDFRawStream;
    expect(new TextDecoder().decode(decodePDFRawStream(embedded).decode())).toBe(xml);
    expect(embedded.dict.get(PDFName.of('Subtype'))).toEqual(PDFName.of('text/xml'));

    const metadata = catalog.lookup(PDFName.of('Metadata')) as PDFRawStream;
    const xmp = new TextDecoder().decode(metadata.contents);
    expect(xmp).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(xmp).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    expect(xmp).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');

    const intent = catalog.lookup(PDFName.of('OutputIntents'), PDFArray).lookup(0, PDFDict);
    expect(intent.get(PDFName.of('S'))).toEqual(PDFName.of('GTS_PDFA1'));
    expect(pdf.getTitle()).toBe('Rechnung RE-2026-001');
  });
});
