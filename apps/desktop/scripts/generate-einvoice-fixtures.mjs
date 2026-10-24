import fs from 'fs';
import path from 'path';

const outDir = path.resolve(process.cwd(), 'apps/desktop/.artifacts/einvoice');
fs.mkdirSync(outDir, { recursive: true });

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-001</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">20260215</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>1</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>Leistung A</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>100.00</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>100.00</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>REF-4711</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:ID>SELLER-001</ram:ID>
        <ram:Name>Billme GmbH</ram:Name>
        <ram:DefinedTradeContact>
          <ram:PersonName>Support Team</ram:PersonName>
          <ram:TelephoneUniversalCommunication>
            <ram:CompleteNumber>+49 30 123456</ram:CompleteNumber>
          </ram:TelephoneUniversalCommunication>
          <ram:EmailURIUniversalCommunication>
            <ram:URIID>info@billme.app</ram:URIID>
          </ram:EmailURIUniversalCommunication>
        </ram:DefinedTradeContact>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>10115</ram:PostcodeCode>
          <ram:LineOne>Hauptstr. 1</ram:LineOne>
          <ram:CityName>Berlin</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">info@billme.app</ram:URIID>
        </ram:URIUniversalCommunication>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">DE123456789</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Kunde GmbH</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>20095</ram:PostcodeCode>
          <ram:LineOne>Kundenweg 5</ram:LineOne>
          <ram:CityName>Hamburg</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">rechnung@kunde-gmbh.de</ram:URIID>
        </ram:URIUniversalCommunication>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">20260215</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>DE89370400440532013000</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>19.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>100.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20260222</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>100.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">19.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>119.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>119.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;

const ps = `%!PS-Adobe-3.0
%%Pages: 1
%%BoundingBox: 0 0 595 842
%%EndComments
/Helvetica findfont 18 scalefont setfont
72 760 moveto
(Billme E-Invoice Validation Fixture) show
/Helvetica findfont 12 scalefont setfont
72 736 moveto
(Invoice: RE-2026-001) show
showpage
%%EOF
`;

// XRechnung 3.0 (CII) from the real builder, so the validator checks what Billme exports.
// Node >= 23.6 strips the TypeScript types of the builder module itself.
const { buildZugferdXml } = await import('../../../packages/desktop-services/src/einvoice/zugferdXml.ts');
const xrechnung = buildZugferdXml({
  invoiceNumber: 'RE-2026-002',
  typeCode: '380',
  issueDate: '2026-02-15',
  dueDate: '2026-03-01',
  currency: 'EUR',
  seller: {
    name: 'Billme GmbH', street: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE',
    vatId: 'DE123456789', taxId: '12/345/67890', iban: 'DE89370400440532013000',
    contactName: 'Support Team', phone: '+49 30 123456', email: 'info@billme.app',
  },
  buyer: { name: 'Stadt Musterhausen', street: 'Rathausplatz 1', city: 'Hamburg', postalCode: '20095', countryCode: 'DE' },
  buyerEmail: 'rechnungseingang@musterhausen.example',
  buyerReference: '04011000-12345-67',
  delivery: { date: '2026-02-10' },
  skonto: { percent: 2, days: 10 },
  lines: [
    { lineId: '1', name: 'Wartung', quantity: 2, unitCode: 'C62', netUnitPrice: 100, netLineTotal: 200, taxRate: 19, taxCategoryCode: 'S', lineKind: 'item' },
    { lineId: '2', name: 'Fachbuch', quantity: 1, unitCode: 'C62', netUnitPrice: 30, netLineTotal: 30, taxRate: 7, taxCategoryCode: 'S', lineKind: 'item' },
  ],
  allowances: [],
  totals: { lineNetTotal: 230, taxTotal: 40.1, grandTotal: 270.1 },
}, { profile: 'xrechnung' });

fs.writeFileSync(path.join(outDir, 'invoice.xml'), xml, 'utf8');
fs.writeFileSync(path.join(outDir, 'xrechnung.xml'), xrechnung, 'utf8');
fs.writeFileSync(path.join(outDir, 'fixture.ps'), ps, 'utf8');

console.log(`Wrote fixtures to ${outDir}`);
