import type { NormalizedEinvoice } from './normalizeInvoiceForEinvoice';

const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const formatAmount = (value: number): string => value.toFixed(2);
const formatQuantity = (value: number): string => Number(value.toFixed(6)).toString();

export const buildZugferdXml = (doc: NormalizedEinvoice): string => {
  const linesXml = doc.lines
    .map(
      (line) => `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${xmlEscape(line.lineId)}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${xmlEscape(line.name)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${formatAmount(line.netUnitPrice)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${xmlEscape(line.unitCode)}">${formatQuantity(line.quantity)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${line.taxCategoryCode}</ram:CategoryCode>
          <ram:RateApplicablePercent>${formatAmount(line.taxRate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${formatAmount(line.netLineTotal)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`,
    )
    .join('\n');

  const exemptionXml = doc.lines[0]?.taxExemptionReason
    ? `
          <ram:ExemptionReason>${xmlEscape(doc.lines[0].taxExemptionReason)}</ram:ExemptionReason>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${xmlEscape(doc.invoiceNumber)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${doc.issueDate.replaceAll('-', '')}</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${linesXml}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${xmlEscape(doc.seller.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${xmlEscape(doc.seller.postalCode)}</ram:PostcodeCode>
          <ram:LineOne>${xmlEscape(doc.seller.street)}</ram:LineOne>
          <ram:CityName>${xmlEscape(doc.seller.city)}</ram:CityName>
          <ram:CountryID>${xmlEscape(doc.seller.countryCode)}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${doc.seller.vatId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(doc.seller.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
        ${doc.seller.taxId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${xmlEscape(doc.seller.taxId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${xmlEscape(doc.buyer.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${xmlEscape(doc.buyer.postalCode)}</ram:PostcodeCode>
          <ram:LineOne>${xmlEscape(doc.buyer.street)}</ram:LineOne>
          <ram:CityName>${xmlEscape(doc.buyer.city)}</ram:CityName>
          <ram:CountryID>${xmlEscape(doc.buyer.countryCode)}</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${doc.currency}</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${formatAmount(doc.totals.taxTotal)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${formatAmount(doc.totals.lineNetTotal)}</ram:BasisAmount>
        <ram:CategoryCode>${doc.lines[0]?.taxCategoryCode ?? 'S'}</ram:CategoryCode>
        <ram:RateApplicablePercent>${formatAmount(doc.lines[0]?.taxRate ?? 0)}</ram:RateApplicablePercent>${exemptionXml}
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${doc.dueDate.replaceAll('-', '')}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${formatAmount(doc.totals.lineNetTotal)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${formatAmount(doc.totals.lineNetTotal)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${doc.currency}">${formatAmount(doc.totals.taxTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${formatAmount(doc.totals.grandTotal)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${formatAmount(doc.totals.grandTotal)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
};
