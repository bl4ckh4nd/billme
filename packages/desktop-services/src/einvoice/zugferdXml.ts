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

const EN16931_GUIDELINE_ID = 'urn:cen.eu:en16931:2017';
export const XRECHNUNG_CII_GUIDELINE_ID = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';

/**
 * CII XML (EN 16931). `xrechnung` sets the XRechnung 3.0 guideline id (BT-24)
 * and adds what its CIUS requires on top: business process (BT-23), seller
 * contact (BG-6) and the electronic addresses of seller (BT-34) and buyer (BT-49).
 */
export const buildZugferdXml = (doc: NormalizedEinvoice, options: { profile?: 'en16931' | 'xrechnung' } = {}): string => {
  const xrechnung = options.profile === 'xrechnung';
  const electronicAddress = (email: string | undefined) => xrechnung && email ? `
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">${xmlEscape(email)}</ram:URIID>
        </ram:URIUniversalCommunication>` : '';
  const sellerContact = xrechnung ? `
        <ram:DefinedTradeContact>
          <ram:PersonName>${xmlEscape(doc.seller.contactName ?? doc.seller.name)}</ram:PersonName>${doc.seller.phone ? `
          <ram:TelephoneUniversalCommunication>
            <ram:CompleteNumber>${xmlEscape(doc.seller.phone)}</ram:CompleteNumber>
          </ram:TelephoneUniversalCommunication>` : ''}${doc.seller.email ? `
          <ram:EmailURIUniversalCommunication>
            <ram:URIID>${xmlEscape(doc.seller.email)}</ram:URIID>
          </ram:EmailURIUniversalCommunication>` : ''}
        </ram:DefinedTradeContact>` : '';
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
        </ram:ApplicableTradeTax>${line.allowance ? `
        <ram:SpecifiedTradeAllowanceCharge>
          <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>
          <ram:ActualAmount>${formatAmount(line.allowance.amount)}</ram:ActualAmount>
          <ram:Reason>${xmlEscape(line.allowance.reason)}</ram:Reason>
        </ram:SpecifiedTradeAllowanceCharge>` : ''}
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${formatAmount(line.netLineTotal)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`,
    )
    .join('\n');

  const taxGroupsByKey = new Map<string, NormalizedEinvoice['lines'][number]>();
  doc.lines.forEach((line) => {
    const key = `${line.taxCategoryCode}:${line.taxRate}`;
    const current = taxGroupsByKey.get(key) ?? { ...line, netLineTotal: 0 };
    current.netLineTotal += line.netLineTotal;
    taxGroupsByKey.set(key, current);
  });
  for (const allowance of doc.allowances ?? []) {
    const key = `${allowance.taxCategoryCode}:${allowance.taxRate}`;
    const group = taxGroupsByKey.get(key) ?? {
      lineId: '', name: allowance.reason, quantity: 0, unitCode: 'C62', netUnitPrice: 0,
      netLineTotal: 0, taxRate: allowance.taxRate, taxCategoryCode: allowance.taxCategoryCode,
      taxExemptionReason: allowance.taxExemptionReason, lineKind: 'item' as const,
    };
    group.netLineTotal -= allowance.amount;
    taxGroupsByKey.set(key, group);
  }
  const allowanceTotal = (doc.allowances ?? []).reduce((total, allowance) => total + allowance.amount, 0);
  const allowancesXml = (doc.allowances ?? []).map((allowance) => `
      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>
        <ram:ActualAmount>${formatAmount(allowance.amount)}</ram:ActualAmount>
        <ram:Reason>${xmlEscape(allowance.reason)}</ram:Reason>
        <ram:CategoryTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${allowance.taxCategoryCode}</ram:CategoryCode>
          <ram:RateApplicablePercent>${formatAmount(allowance.taxRate)}</ram:RateApplicablePercent>
        </ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>`).join('');
  const taxGroups = [...taxGroupsByKey.values()];
  const taxGroupsXml = taxGroups.map((group) => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${formatAmount(group.taxCategoryCode === 'S' ? group.netLineTotal * group.taxRate / 100 : 0)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        ${group.taxExemptionReason ? `<ram:ExemptionReason>${xmlEscape(group.taxExemptionReason)}</ram:ExemptionReason>` : ''}
        <ram:BasisAmount>${formatAmount(group.netLineTotal)}</ram:BasisAmount>
        <ram:CategoryCode>${group.taxCategoryCode}</ram:CategoryCode>
        <ram:RateApplicablePercent>${formatAmount(group.taxRate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
  <rsm:ExchangedDocumentContext>${xrechnung ? `
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>` : ''}
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${xrechnung ? XRECHNUNG_CII_GUIDELINE_ID : EN16931_GUIDELINE_ID}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${xmlEscape(doc.invoiceNumber)}</ram:ID>
    <ram:TypeCode>${doc.typeCode}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${doc.issueDate.replaceAll('-', '')}</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${linesXml}
    <ram:ApplicableHeaderTradeAgreement>${doc.buyerReference ? `
      <ram:BuyerReference>${xmlEscape(doc.buyerReference)}</ram:BuyerReference>` : ''}
      <ram:SellerTradeParty>
        <ram:Name>${xmlEscape(doc.seller.name)}</ram:Name>${sellerContact}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${xmlEscape(doc.seller.postalCode)}</ram:PostcodeCode>
          <ram:LineOne>${xmlEscape(doc.seller.street)}</ram:LineOne>
          <ram:CityName>${xmlEscape(doc.seller.city)}</ram:CityName>
          <ram:CountryID>${xmlEscape(doc.seller.countryCode)}</ram:CountryID>
        </ram:PostalTradeAddress>${electronicAddress(doc.seller.email)}
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
        </ram:PostalTradeAddress>${electronicAddress(doc.buyerEmail)}
        ${doc.buyerVatId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(doc.buyerVatId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    ${doc.delivery && 'date' in doc.delivery ? `<ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">${doc.delivery.date.replaceAll('-', '')}</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>` : '<ram:ApplicableHeaderTradeDelivery/>'}
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${doc.currency}</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>${doc.seller.iban ? '58' : '1'}</ram:TypeCode>
        ${doc.seller.iban ? `<ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${xmlEscape(doc.seller.iban)}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>` : ''}
      </ram:SpecifiedTradeSettlementPaymentMeans>
${taxGroupsXml}${doc.delivery && 'start' in doc.delivery ? `
      <ram:BillingSpecifiedPeriod>
        <ram:StartDateTime><udt:DateTimeString format="102">${doc.delivery.start.replaceAll('-', '')}</udt:DateTimeString></ram:StartDateTime>
        <ram:EndDateTime><udt:DateTimeString format="102">${doc.delivery.end.replaceAll('-', '')}</udt:DateTimeString></ram:EndDateTime>
      </ram:BillingSpecifiedPeriod>` : ''}
${allowancesXml}
      <ram:SpecifiedTradePaymentTerms>${doc.skonto ? `
        <ram:Description>#SKONTO#TAGE=${doc.skonto.days}#PROZENT=${doc.skonto.percent.toFixed(2)}#
</ram:Description>` : ''}
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${doc.dueDate.replaceAll('-', '')}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${formatAmount(doc.totals.lineNetTotal)}</ram:LineTotalAmount>
        ${allowanceTotal ? `<ram:AllowanceTotalAmount>${formatAmount(allowanceTotal)}</ram:AllowanceTotalAmount>` : ''}
        <ram:TaxBasisTotalAmount>${formatAmount(doc.totals.lineNetTotal - allowanceTotal)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${doc.currency}">${formatAmount(doc.totals.taxTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${formatAmount(doc.totals.grandTotal)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${formatAmount(doc.totals.grandTotal)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>${doc.precedingInvoice ? `
      <ram:InvoiceReferencedDocument>
        <ram:IssuerAssignedID>${xmlEscape(doc.precedingInvoice.number)}</ram:IssuerAssignedID>
        <ram:FormattedIssueDateTime><qdt:DateTimeString format="102">${doc.precedingInvoice.date.replaceAll('-', '')}</qdt:DateTimeString></ram:FormattedIssueDateTime>
      </ram:InvoiceReferencedDocument>` : ''}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
};
