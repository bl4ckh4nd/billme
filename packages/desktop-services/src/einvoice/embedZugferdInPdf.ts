import { AFRelationship, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { SRGB_ICC_BASE64 } from './srgbIcc';

type EmbedParams = {
  pdfBytes: Uint8Array;
  xml: string;
  invoiceNumber: string;
  /** Factur-X conformance level written to the XMP metadata. */
  conformanceLevel?: 'EN 16931';
  now?: Date;
};

export const FACTURX_FILENAME = 'factur-x.xml';

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const xmpDate = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * XMP for PDF/A-3B plus the Factur-X/ZUGFeRD extension schema. PDF/A requires
 * custom namespaces to be declared through `pdfaExtension`, otherwise
 * validators reject the `fx:` properties.
 */
const buildXmp = (title: string, conformanceLevel: string, now: Date) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>Billme</rdf:li></rdf:Seq></dc:creator>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>Billme</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>Billme</xmp:CreatorTool>
      <xmp:CreateDate>${xmpDate(now)}</xmp:CreateDate>
      <xmp:ModifyDate>${xmpDate(now)}</xmp:ModifyDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${conformanceLevel}</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The name of the embedded XML document</pdfaProperty:description></rdf:li>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The type of the hybrid document in capital letters, e.g. INVOICE or ORDER</pdfaProperty:description></rdf:li>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the standard applying to the embedded XML document</pdfaProperty:description></rdf:li>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the embedded XML document</pdfaProperty:description></rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/**
 * Turns the printed PDF into a ZUGFeRD/Factur-X hybrid invoice: the XML is
 * attached as `factur-x.xml` (AFRelationship Alternative, referenced from the
 * catalog's AF array), with PDF/A-3B identification, the Factur-X XMP schema
 * and an sRGB output intent.
 *
 * ponytail: Chromium's printToPDF output is not validated against the full
 * PDF/A-3 rule set (e.g. transparency groups); readers extract the XML fine.
 * Replace with a veraPDF-checked pipeline if strict archival conformance is required.
 */
export const embedZugferdInPdf = async ({
  pdfBytes,
  xml,
  invoiceNumber,
  conformanceLevel = 'EN 16931',
  now = new Date(),
}: EmbedParams): Promise<Uint8Array> => {
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const title = `Rechnung ${invoiceNumber}`;

  await pdf.attach(new TextEncoder().encode(xml), FACTURX_FILENAME, {
    mimeType: 'text/xml',
    description: 'Factur-X/ZUGFeRD Rechnungsdaten',
    creationDate: now,
    modificationDate: now,
    afRelationship: AFRelationship.Alternative,
  });

  // The document information dictionary must match the XMP metadata.
  pdf.setTitle(title);
  pdf.setCreator('Billme');
  pdf.setProducer('Billme');
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);

  const context = pdf.context;
  const metadata = context.stream(new TextEncoder().encode(buildXmp(title, conformanceLevel, now)), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  pdf.catalog.set(PDFName.of('Metadata'), context.register(metadata));

  const icc = context.flateStream(Uint8Array.from(atob(SRGB_ICC_BASE64), (char) => char.charCodeAt(0)), { N: 3 });
  const outputIntent = context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: context.register(icc),
  });
  pdf.catalog.set(PDFName.of('OutputIntents'), context.obj([context.register(outputIntent)]));

  return pdf.save({ useObjectStreams: false });
};
