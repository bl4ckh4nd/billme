import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { createDocumentExportPreparer } from '@billme/desktop-services/documentExport';
import { readFile } from 'node:fs/promises';
import { startLite, startPro, type LiteHarness, type ProHarness } from './harness.js';
import { asSmallBusiness, draftInvoice, draftOffer, issueInvoice } from './fixtures.js';
import { configureLite, issueDated, line } from './reports-fixtures.js';

/**
 * ZUGFeRD / Factur-X (EN 16931) through the real export pipeline.
 *
 * Electron's main process builds the e-invoice after printing
 * (`createDocumentExportPreparer` → render-context over HTTP → normalize → CII
 * XML → `finalize(pdf)` embeds it). Here the same function runs against the
 * real embedded backend; the "printed" PDF is a pdf-lib page, and the result is
 * read back like a receiving system would: attachment, XML, XMP, output intent.
 *
 * How this can fail (each one has a test below):
 * - the XML differs from the invoice: totals, VAT per rate, VAT groups whose
 *   sum is not the tax total, discounts, optional lines billed, dates, number;
 *   a position discount (percent or EUR amount) lost, not stored, or folded into
 *   the unit price instead of a line allowance (BG-27)
 * - parties: seller VAT ID / tax number missing, buyer address cut, a buyer
 *   address in one line ("Straße 1, 12345 Ort", as clients are often typed)
 *   refused as "Käufer PLZ fehlt", a refusal without a way out, a special
 *   character (& < > ") breaking the XML, a non-German country ignored
 * - references: no delivery date (BT-72) or service period (BG-14) although the
 *   invoice states one, a correction without the invoice it corrects (BT-25),
 *   the Leitweg-ID (BT-10) or agreed Skonto (BT-20) lost, any of them out of
 *   CII schema order
 * - tax category per mode: standard S, Kleinunternehmer E, reverse charge AE,
 *   intra-EU supply K, export G, exempt E, outside scope O; rates not forced
 *   to 0, exemption reason missing, buyer VAT ID lost
 * - document type: credit note / cancellation exported as an invoice (380 vs 381)
 * - the container: no factur-x.xml attachment, wrong relationship, no AF entry,
 *   missing XMP/PDF-A identification, no output intent, a corrupt PDF accepted
 * - when it must NOT happen: e-invoicing disabled, offers, incomplete seller or
 *   buyer address, nothing billable
 * - EN 16931 conformance details a validator would reject (see the todos)
 *
 * XRechnung export (`documents:exportXRechnung`, CII) and reading received
 * e-invoices (`einvoice:parse`), Lite and Pro:
 * - the XRechnung carries the wrong guideline id (BT-24), loses the seller
 *   contact (BG-6), the electronic addresses (BT-34/BT-49) or the Leitweg-ID,
 *   or its totals and VAT groups differ from the invoice when read back
 * - a draft, a document without Leitweg-ID, seller phone/e-mail or buyer
 *   e-mail is exported anyway instead of 422 with the missing fields named
 * - the ZUGFeRD export starts to carry XRechnung-only elements
 * - reading: the embedded XML of a ZUGFeRD PDF is not found, a UBL invoice is
 *   misread (entities, leading zeros, dates, VAT per rate, IBAN), a credit note
 *   is not flagged
 * - hostile or wrong input: a DOCTYPE/ENTITY payload is parsed (XXE), a PDF
 *   without e-invoice or a random text is accepted, bad base64 passes
 */

const xmlOf = (container: Awaited<ReturnType<typeof readFacturX>>) => container.files[0]!.xml;
const first = (xml: string, tag: string) => new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml)?.[1];
const blocks = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!);
const unescapeXml = (value: string) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const settlement = (xml: string) => xml.split('<ram:ApplicableHeaderTradeSettlement>')[1]!;
const headerTaxes = (xml: string) => blocks(settlement(xml), 'ram:ApplicableTradeTax').map((block) => ({
  category: first(block, 'ram:CategoryCode'), rate: Number(first(block, 'ram:RateApplicablePercent')), basis: Number(first(block, 'ram:BasisAmount')),
  calculated: Number(first(block, 'ram:CalculatedAmount')), reason: first(block, 'ram:ExemptionReason'), block,
}));
const date102 = (iso: string) => iso.replaceAll('-', '');
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** A tiny well-formedness check: balanced tags, only declared entities. */
const assertWellFormed = (xml: string) => {
  const stack: string[] = [];
  let position = 0;
  for (const token of xml.matchAll(/<[^>]*>/g)) {
    const text = xml.slice(position, token.index);
    assert.ok(!/[<>]/.test(text) && !/&(?!(amp|lt|gt|quot|apos);)/.test(text), `unescaped text: ${text.slice(0, 60)}`);
    position = token.index! + token[0].length;
    const tag = token[0];
    if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
    if (tag.startsWith('</')) { assert.equal(stack.pop(), tag.slice(2, -1).trim(), `closing ${tag}`); continue; }
    const name = /^<([^\s/>]+)/.exec(tag)![1]!;
    assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(tag.replace(/"[^"]*"/g, '')), `attribute in ${tag}`);
    if (!tag.endsWith('/>')) stack.push(name);
  }
  assert.deepEqual(stack, [], 'unclosed tags');
};

const blankPdf = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595.28, 841.89]);
  return pdf.save();
};

/** What a receiving system does with the hybrid PDF. */
const readFacturX = async (bytes: Uint8Array) => {
  const pdf = await PDFDocument.load(bytes);
  const catalog = pdf.catalog;
  const names = catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
  const files: Array<{ name: string; xml: string; relationship: unknown; mime: unknown; description?: string }> = [];
  for (let i = 0; i < names.size(); i += 2) {
    const spec = names.lookup(i + 1, PDFDict);
    const stream = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F')) as PDFRawStream;
    files.push({
      name: (names.lookup(i) as PDFString).decodeText(),
      xml: new TextDecoder().decode(decodePDFRawStream(stream).decode()),
      relationship: spec.get(PDFName.of('AFRelationship')),
      mime: stream.dict.get(PDFName.of('Subtype')),
      description: (spec.lookup(PDFName.of('Desc')) as PDFString | undefined)?.decodeText(),
    });
  }
  const xmp = new TextDecoder().decode((catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).contents);
  const intent = catalog.lookup(PDFName.of('OutputIntents'), PDFArray).lookup(0, PDFDict);
  return { pdf, files, xmp, afCount: catalog.lookup(PDFName.of('AF'), PDFArray).size(), outputIntent: intent.get(PDFName.of('S')), title: pdf.getTitle(), pages: pdf.getPageCount() };
};

describe('e-invoice export (Lite)', () => {
  let h: LiteHarness;
  let prepare: ReturnType<typeof createDocumentExportPreparer>;
  const stored = async (id: string) => (await h.api.invoices.list()).find((invoice) => invoice.id === id)!;
  /** The renderer's "PDF exportieren": prepare from the render context, then finalize the printed PDF. */
  const exportInvoice = async (id: string) => {
    const prepared = await prepare('invoice', id);
    assert.ok(prepared.finalize, 'e-invoicing is on: the export embeds the XML');
    const container = await readFacturX(await prepared.finalize(await blankPdf()));
    assertWellFormed(xmlOf(container));
    return { prepared, container, xml: xmlOf(container) };
  };

  before(async () => {
    h = await startLite(null, 'einvoice');
    await configureLite(h.api, { eInvoice: true });
    prepare = createDocumentExportPreparer({ product: 'lite', resolveConnection: () => h.connection });
  });
  after(async () => { await h.close(); });

  describe('a standard invoice with 19 % and 7 %', () => {
    let id: string;
    let exported: Awaited<ReturnType<typeof exportInvoice>>;
    before(async () => {
      const invoice = await issueDated(h.api, {
        client: 'Mustermann Bau GmbH', clientEmail: 'bau@example.com', date: '2026-05-04', dueDate: '2026-05-18', servicePeriod: '2026-05-01',
        items: [
          { kind: 'item', description: 'Beratung', quantity: 3, price: 99.99, total: 299.97, taxRate: 19 },
          { kind: 'item', description: 'Fachbuch', quantity: 1, price: 20, total: 20, taxRate: 7 },
        ],
      });
      id = invoice.id;
      exported = await exportInvoice(id);
    });

    test('the file is named after the document and the XML is attached as factur-x.xml (Alternative, listed in AF)', async () => {
      const invoice = await stored(id);
      assert.equal(exported.prepared.suggestedName, `Rechnung-${invoice.number}-Mustermann Bau GmbH`);
      assert.equal(exported.container.files.length, 1);
      const [file] = exported.container.files;
      assert.equal(file!.name, 'factur-x.xml');
      assert.equal(file!.relationship, PDFName.of('Alternative'));
      assert.equal(file!.mime, PDFName.of('text/xml'));
      assert.equal(exported.container.afCount, 1);
      assert.equal(exported.container.pages, 1, 'the printed page survives the embedding');
    });

    test('PDF/A-3B identification, Factur-X XMP (profile EN 16931), title and sRGB output intent', async () => {
      const invoice = await stored(id);
      const { xmp } = exported.container;
      assert.ok(xmp.includes('<pdfaid:part>3</pdfaid:part>') && xmp.includes('<pdfaid:conformance>B</pdfaid:conformance>'));
      assert.ok(xmp.includes('<fx:DocumentType>INVOICE</fx:DocumentType>'));
      assert.ok(xmp.includes('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>'));
      assert.ok(xmp.includes('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>'));
      assert.ok(xmp.includes('urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#'));
      assert.ok(xmp.includes('pdfaExtension:schemas'), 'custom namespace declared for PDF/A');
      assert.equal(exported.container.title, `Rechnung ${invoice.number}`);
      assert.ok(xmp.includes(`Rechnung ${invoice.number}`), 'document info and XMP agree');
      assert.equal(exported.container.outputIntent, PDFName.of('GTS_PDFA1'));
    });

    test('profile, number, type, dates and currency come from the invoice', async () => {
      const invoice = await stored(id);
      const xml = exported.xml;
      assert.equal(first(xml, 'ram:ID'), 'urn:cen.eu:en16931:2017', 'EN 16931 guideline id');
      assert.equal(blocks(xml, 'rsm:ExchangedDocument')[0] && first(blocks(xml, 'rsm:ExchangedDocument')[0]!, 'ram:ID'), invoice.number);
      assert.equal(first(xml, 'ram:TypeCode'), '380');
      assert.equal(blocks(xml, 'ram:IssueDateTime')[0]!.includes(`format="102">${date102('2026-05-04')}<`), true);
      assert.ok(blocks(xml, 'ram:DueDateDateTime')[0]!.includes(`format="102">${date102('2026-05-18')}<`));
      assert.equal(first(xml, 'ram:InvoiceCurrencyCode'), 'EUR');
    });

    test('totals equal the stored tax snapshot and the VAT groups add up to the tax total (BR-CO-14/15)', async () => {
      const invoice = await stored(id);
      const snapshot = invoice.taxSnapshot!;
      const xml = exported.xml;
      const monetary = blocks(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')[0]!;
      assert.equal(Number(first(monetary, 'ram:LineTotalAmount')), snapshot.netAmount);
      assert.equal(Number(first(monetary, 'ram:TaxBasisTotalAmount')), snapshot.netAmount);
      assert.equal(Number(first(monetary, 'ram:TaxTotalAmount')), snapshot.vatAmount);
      assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), snapshot.grossAmount);
      assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), invoice.amount);
      assert.equal(Number(first(monetary, 'ram:DuePayableAmount')), invoice.amount);
      assert.equal(snapshot.netAmount, 319.97);
      assert.equal(snapshot.vatAmount, 58.39);
      const groups = headerTaxes(xml);
      assert.deepEqual(groups.map((g) => [g.category, g.rate, g.basis, g.calculated]).sort(), [['S', 19, 299.97, 56.99], ['S', 7, 20, 1.4]].sort());
      assert.equal(round2(groups.reduce((sum, g) => sum + g.calculated, 0)), snapshot.vatAmount);
      assert.equal(round2(groups.reduce((sum, g) => sum + g.basis, 0)), snapshot.netAmount);
      assert.equal(round2(snapshot.netAmount + snapshot.vatAmount), snapshot.grossAmount);
    });

    test('every billable line is a line item with quantity, net unit price and its own rate', async () => {
      const lines = blocks(exported.xml, 'ram:IncludedSupplyChainTradeLineItem');
      assert.equal(lines.length, 2);
      assert.deepEqual(lines.map((l) => first(l, 'ram:Name')), ['Beratung', 'Fachbuch']);
      assert.deepEqual(lines.map((l) => Number(first(l, 'ram:ChargeAmount'))), [99.99, 20]);
      assert.deepEqual(lines.map((l) => Number(first(l, 'ram:BilledQuantity'))), [3, 1]);
      assert.deepEqual(lines.map((l) => Number(first(l, 'ram:LineTotalAmount'))), [299.97, 20]);
      assert.deepEqual(lines.map((l) => Number(first(l, 'ram:RateApplicablePercent'))), [19, 7]);
      assert.deepEqual(lines.map((l) => first(l, 'ram:CategoryCode')), ['S', 'S']);
    });

    test('seller and buyer: name, address, country, VAT ID and tax number from settings and invoice', async () => {
      const seller = blocks(exported.xml, 'ram:SellerTradeParty')[0]!;
      assert.equal(first(seller, 'ram:Name'), 'Muster Consulting');
      assert.deepEqual([first(seller, 'ram:LineOne'), first(seller, 'ram:PostcodeCode'), first(seller, 'ram:CityName'), first(seller, 'ram:CountryID')], ['Werkstraße 1', '10115', 'Berlin', 'DE']);
      assert.ok(seller.includes('<ram:ID schemeID="VA">DE123456789</ram:ID>'));
      assert.ok(seller.includes('<ram:ID schemeID="FC">12/345/67890</ram:ID>'));
      const buyer = blocks(exported.xml, 'ram:BuyerTradeParty')[0]!;
      assert.equal(first(buyer, 'ram:Name'), 'Mustermann Bau GmbH');
      assert.deepEqual([first(buyer, 'ram:LineOne'), first(buyer, 'ram:PostcodeCode'), first(buyer, 'ram:CityName'), first(buyer, 'ram:CountryID')], ['Hauptstraße 1', '10115', 'Berlin', 'DE']);
      assert.ok(!buyer.includes('SpecifiedTaxRegistration'), 'no buyer VAT ID was given, none is invented');
    });
  });

  describe('every tax treatment maps to its EN 16931 category', () => {
    const modes: Array<[string, string, boolean, string | undefined]> = [
      ['standard_vat', 'S', false, undefined],
      ['small_business_19_ustg', 'E', true, 'Kleinunternehmerregelung nach §19 UStG'],
      ['reverse_charge_13b', 'AE', true, 'Steuerschuldnerschaft des Leistungsempfängers (§13b UStG)'],
      ['intra_eu_supply_6a', 'K', true, 'Steuerfreie innergemeinschaftliche Lieferung'],
      ['intra_eu_service_reverse_charge', 'AE', true, 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)'],
      ['export_third_country', 'G', true, 'Steuerfreie Ausfuhrlieferung'],
      ['vat_exempt_4_ustg', 'E', true, 'Steuerfreie Leistung nach §4 UStG'],
      ['non_taxable_outside_scope', 'O', true, 'Nicht steuerbarer Umsatz'],
    ];
    for (const [mode, category, zero, reason] of modes) {
      test(`${mode} → ${category}${zero ? ', 0 %, with a legal reason, gross = net' : ', VAT charged'}`, async () => {
        // Only a Kleinunternehmer issues under §19.
        const asTenant = async <T,>(body: () => Promise<T>): Promise<T> => {
          if (mode !== 'small_business_19_ustg') return body();
          let result!: T;
          await asSmallBusiness(h.api, async () => { result = await body(); });
          return result;
        };
        const invoice = await asTenant(() => issueDated(h.api, {
          client: `Modus ${mode}`, date: '2026-06-02', servicePeriod: '2026-06-02', taxMode: mode as never,
          taxMeta: { taxRuleConfirmed: true, buyerVatId: 'ATU12345678', buyerCountryCode: 'AT', sellerCountryCode: 'DE' } as never,
          items: [line('Leistung A', 100, 19), line('Leistung B', 50, 7)],
        }));
        const { xml } = await exportInvoice(invoice.id);
        const storedInvoice = await stored(invoice.id);
        const groups = headerTaxes(xml);
        assert.ok(groups.every((g) => g.category === category), `${mode}: ${groups.map((g) => g.category)}`);
        const monetary = blocks(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')[0]!;
        assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), storedInvoice.taxSnapshot!.grossAmount);
        if (!zero) {
          assert.deepEqual(groups.map((g) => g.rate).sort((a, b) => a - b), [7, 19]);
          assert.ok(groups.every((g) => g.reason === undefined), 'a taxed supply carries no exemption reason');
          assert.equal(Number(first(monetary, 'ram:TaxTotalAmount')), 22.5);
          return;
        }
        assert.ok(groups.every((g) => g.rate === 0), 'zero-rated whatever the lines say');
        assert.ok(blocks(xml, 'ram:IncludedSupplyChainTradeLineItem').every((l) => Number(first(l, 'ram:RateApplicablePercent')) === 0 && first(l, 'ram:CategoryCode') === category));
        assert.equal(Number(first(monetary, 'ram:TaxTotalAmount')), 0);
        assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), 150);
        assert.ok(groups.every((g) => g.reason && unescapeXml(g.reason) === reason), `${mode} reason: ${groups.map((g) => g.reason)}`);
        assert.ok(groups.every((g) => g.calculated === 0));
      });
    }

    test('reverse charge keeps the buyer VAT ID of the invoice, with scheme VA', async () => {
      const invoice = await issueDated(h.api, {
        client: 'Reverse AG', date: '2026-06-03', servicePeriod: '2026-06-03', taxMode: 'reverse_charge_13b',
        taxMeta: { taxRuleConfirmed: true, buyerVatId: ' ATU12345678 ' } as never, items: [line('Bauleistung', 1000)],
      });
      const { xml } = await exportInvoice(invoice.id);
      const buyer = blocks(xml, 'ram:BuyerTradeParty')[0]!;
      assert.ok(buyer.includes('<ram:ID schemeID="VA">ATU12345678</ram:ID>'), 'trimmed, scheme VA');
      assert.equal(headerTaxes(xml)[0]!.category, 'AE');
    });

    test('modes that need a buyer VAT ID (13b, intra-EU supply, EU service) cannot even be issued without one (BR-AE-02 / BR-IC-02)', async () => {
      for (const mode of ['reverse_charge_13b', 'intra_eu_supply_6a', 'intra_eu_service_reverse_charge']) {
        await assert.rejects(issueDated(h.api, { client: `Ohne USt-IdNr ${mode}`, date: '2026-06-04', servicePeriod: '2026-06-04', taxMode: mode as never, taxMeta: { taxRuleConfirmed: true } as never, items: [line('Leistung', 1000)] }), /USt-IdNr\. des Kunden fehlt/, mode);
      }
    });

    test('an explicit exemption reason wins, and AT/CH sellers do not cite German statutes', async () => {
      const reasonOf = async (taxMode: string, taxMeta: Record<string, unknown>) => {
        const invoice = await issueDated(h.api, { client: `Grund ${taxMode}`, date: '2026-06-05', servicePeriod: '2026-06-05', taxMode: taxMode as never, taxMeta: { taxRuleConfirmed: true, buyerVatId: 'ATU12345678', ...taxMeta } as never, items: [line('Leistung', 100)] });
        return unescapeXml(headerTaxes((await exportInvoice(invoice.id)).xml)[0]!.reason!);
      };
      assert.equal(await reasonOf('vat_exempt_4_ustg', { exemptionReasonOverride: ' Steuerfrei nach § 4 Nr. 14 UStG ' }), 'Steuerfrei nach § 4 Nr. 14 UStG');
      await asSmallBusiness(h.api, async () => {
        assert.equal(await reasonOf('small_business_19_ustg', { sellerCountryCode: 'AT' }), 'Kleinunternehmerregelung nach UStG');
        assert.equal(await reasonOf('small_business_19_ustg', { sellerCountryCode: 'CH' }), 'Keine MWST wegen Kleinunternehmen');
      });
      assert.equal(await reasonOf('reverse_charge_13b', { sellerCountryCode: 'AT' }), 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)');
    });
  });

  describe('credit notes and cancellations', () => {
    test('a cancellation invoice is a credit note (381), amounts stay positive and refer to the same tax treatment', async () => {
      const source = await issueDated(h.api, { client: 'Storno Kunde', date: '2026-06-10', servicePeriod: '2026-06-10', items: [line('Beratung', 200, 19)] });
      const cancellation = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'cancellation_invoice', date: '2026-06-12', dueDate: '2026-06-12', reason: 'Storno' } as never);
      const { xml, prepared } = await exportInvoice(cancellation.id);
      assert.match(prepared.suggestedName, /^Stornorechnung-|^Storno/i);
      assert.equal(first(xml, 'ram:TypeCode'), '381');
      assert.equal(blocks(xml, 'rsm:ExchangedDocument').map((b) => first(b, 'ram:ID'))[0], cancellation.number);
      const monetary = blocks(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')[0]!;
      assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), 238);
      assert.equal(Number(first(monetary, 'ram:TaxTotalAmount')), 38);
      assert.equal(blocks(xml, 'ram:IssueDateTime')[0]!.includes(date102('2026-06-12')), true);
      const settlement = blocks(xml, 'ram:ApplicableHeaderTradeSettlement')[0]!;
      const referenced = blocks(settlement, 'ram:InvoiceReferencedDocument')[0];
      assert.ok(referenced, 'BT-25: the corrected invoice is referenced');
      assert.equal(first(referenced!, 'ram:IssuerAssignedID'), source.number);
      assert.ok(referenced!.includes(`format="102">${date102('2026-06-10')}<`), 'BT-26: its date');
      assert.ok(settlement.indexOf('</ram:SpecifiedTradeSettlementHeaderMonetarySummation>') < settlement.indexOf('<ram:InvoiceReferencedDocument>'), 'CII order: after the totals');
    });

    test('delivery date (BT-72), service period (BG-14) and Leitweg-ID (BT-10) in schema order', async () => {
      const single = await issueDated(h.api, { client: 'Lieferdatum GmbH', date: '2026-06-20', servicePeriod: '2026-06-18', items: [line('Leistung', 100, 19)] });
      const delivery = blocks((await exportInvoice(single.id)).xml, 'ram:ApplicableHeaderTradeDelivery')[0]!;
      assert.ok(delivery.includes(`<ram:OccurrenceDateTime>`) && delivery.includes(date102('2026-06-18')), 'BT-72 from the service date');

      const draft = await draftInvoice(h.api, { client: 'Stadtverwaltung', date: '2026-06-30', items: [line('Wartung', 100, 19)], taxMeta: { buyerReference: '04011000-12345-67' } as never });
      const periodic = await h.api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...draft, servicePeriod: '2026-06-01 bis 2026-06-30', status: 'open' } });
      const { xml } = await exportInvoice(periodic.id);
      const agreement = blocks(xml, 'ram:ApplicableHeaderTradeAgreement')[0]!;
      assert.equal(first(agreement, 'ram:BuyerReference'), '04011000-12345-67');
      assert.ok(agreement.indexOf('<ram:BuyerReference>') < agreement.indexOf('<ram:SellerTradeParty>'), 'BT-10 is the first child of the agreement');
      const settlement = blocks(xml, 'ram:ApplicableHeaderTradeSettlement')[0]!;
      const period = blocks(settlement, 'ram:BillingSpecifiedPeriod')[0]!;
      assert.ok(blocks(period, 'ram:StartDateTime')[0]!.includes(date102('2026-06-01')) && blocks(period, 'ram:EndDateTime')[0]!.includes(date102('2026-06-30')));
      assert.ok(settlement.lastIndexOf('</ram:ApplicableTradeTax>') < settlement.indexOf('<ram:BillingSpecifiedPeriod>'), 'CII order: after the VAT breakdown');
      assert.ok(settlement.indexOf('</ram:BillingSpecifiedPeriod>') < settlement.indexOf('<ram:SpecifiedTradePaymentTerms>'), 'CII order: before the payment terms');
      assert.ok(!blocks(xml, 'ram:ApplicableHeaderTradeDelivery')[0], 'a period is not also a single delivery date');
    });

    test('agreed Skonto is in the payment terms in the XRechnung syntax (BT-20, BR-DE-18)', async () => {
      const draft = await draftInvoice(h.api, { client: 'Skonto Empfänger', date: '2026-07-01', dueDate: '2026-07-31', items: [line('Leistung', 100, 19)] });
      const issued = await h.api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...draft, servicePeriod: '2026-07-01', skonto: { percent: 2, days: 10 }, status: 'open' } });
      const terms = blocks((await exportInvoice(issued.id)).xml, 'ram:SpecifiedTradePaymentTerms')[0]!;
      assert.match(first(terms, 'ram:Description') ?? '', /^#SKONTO#TAGE=10#PROZENT=2\.00#\n$/);
      assert.ok(terms.indexOf('<ram:Description>') < terms.indexOf('<ram:DueDateDateTime>'), 'CII order: the description comes first');
    });

    test('a partial credit note is 381 with the credited share of the lines', async () => {
      const source = await issueDated(h.api, { client: 'Gutschrift Kunde', date: '2026-06-11', servicePeriod: '2026-06-11', items: [line('Beratung', 200, 19)] });
      const credit = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'credit_note', amount: 59.5, date: '2026-06-13', dueDate: '2026-06-13', reason: 'Teilgutschrift' } as never);
      const { xml } = await exportInvoice(credit.id);
      assert.equal(first(xml, 'ram:TypeCode'), '381');
      const monetary = blocks(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')[0]!;
      assert.equal(Number(first(monetary, 'ram:LineTotalAmount')), 50);
      assert.equal(Number(first(monetary, 'ram:TaxTotalAmount')), 9.5);
      assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), 59.5);
      const [item] = blocks(xml, 'ram:IncludedSupplyChainTradeLineItem');
      assert.deepEqual([Number(first(item!, 'ram:BilledQuantity')), Number(first(item!, 'ram:ChargeAmount')), Number(first(item!, 'ram:LineTotalAmount'))], [0.25, 200, 50]);
    });

    test('a normal invoice stays 380 even after it was cancelled', async () => {
      const source = await issueDated(h.api, { client: 'Bleibt 380', date: '2026-06-14', servicePeriod: '2026-06-14', items: [line('Beratung', 100, 19)] });
      await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'cancellation_invoice', date: '2026-06-15', dueDate: '2026-06-15', reason: 'Storno' } as never);
      const { xml } = await exportInvoice(source.id);
      assert.equal(first(xml, 'ram:TypeCode'), '380');
    });
  });

  describe('content that must survive the XML', () => {
    test('special characters and umlauts are escaped and round-trip', async () => {
      const client = 'Müller & Söhne <Bau> "GmbH" O\'Neil';
      const invoice = await issueDated(h.api, { client, date: '2026-06-20', servicePeriod: '2026-06-20', items: [line('Rahmen & Dübel <M8> "Stahl"', 80, 19)] });
      const { xml } = await exportInvoice(invoice.id);
      assert.ok(xml.includes('Müller &amp; Söhne &lt;Bau&gt; &quot;GmbH&quot; O&apos;Neil'));
      assert.equal(unescapeXml(first(blocks(xml, 'ram:BuyerTradeParty')[0]!, 'ram:Name')!), client);
      assert.equal(unescapeXml(first(blocks(xml, 'ram:IncludedSupplyChainTradeLineItem')[0]!, 'ram:Name')!), 'Rahmen & Dübel <M8> "Stahl"');
    });

    test('discounts reduce the net, text lines vanish and optional lines are listed at zero (not billed)', async () => {
      const invoice = await issueDated(h.api, {
        client: 'Rabatt Kunde', date: '2026-06-21', servicePeriod: '2026-06-21',
        items: [
          { kind: 'item', description: 'Arbeit', quantity: 10, price: 80, total: 800, taxRate: 19 },
          { kind: 'optional', description: 'Option, nicht beauftragt', quantity: 1, price: 200, total: 200, taxRate: 19 },
          { kind: 'text', description: 'Hinweis ohne Betrag', quantity: 0, price: 0, total: 0 },
          { kind: 'item', description: 'Rabatt', quantity: 1, price: -80, total: -80, taxRate: 19 },
        ],
      });
      const { xml } = await exportInvoice(invoice.id);
      const names = blocks(xml, 'ram:IncludedSupplyChainTradeLineItem').map((l) => first(l, 'ram:Name')!);
      assert.deepEqual(names.map(unescapeXml), ['Arbeit', 'Option, nicht beauftragt (Optional)']);
      assert.equal(unescapeXml(first(blocks(xml, 'ram:SpecifiedTradeAllowanceCharge')[0]!, 'ram:Reason')!), 'Rabatt');
      const monetary = blocks(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')[0]!;
      assert.equal(Number(first(monetary, 'ram:LineTotalAmount')), 800);
      assert.equal(Number(first(monetary, 'ram:AllowanceTotalAmount')), 80);
      assert.equal(Number(first(monetary, 'ram:TaxBasisTotalAmount')), 720);
      assert.equal(Number(first(monetary, 'ram:TaxTotalAmount')), 136.8);
      assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), 856.8);
      assert.equal(headerTaxes(xml)[0]!.basis, 720);
      const optional = blocks(xml, 'ram:IncludedSupplyChainTradeLineItem')[1]!;
      assert.deepEqual([Number(first(optional, 'ram:ChargeAmount')), Number(first(optional, 'ram:LineTotalAmount'))], [0, 0], 'listed, but not billed');
    });

    test('a position discount in percent or EUR is stored, priced and exported as line allowance (BG-27)', async () => {
      const invoice = await issueDated(h.api, {
        client: 'Positionsrabatt Kunde', date: '2026-06-22', servicePeriod: '2026-06-22',
        items: [
          { kind: 'item', description: 'Leuchte', quantity: 2, price: 89, discountPercent: 10, total: 160.2, taxRate: 19 },
          { kind: 'item', description: 'Montage', quantity: 1, price: 100, discountAmount: 20, total: 80, taxRate: 19 },
        ],
      });
      const saved = await stored(invoice.id);
      assert.deepEqual(saved.items.map((item) => [item.discountPercent, item.discountAmount]), [[10, undefined], [undefined, 20]], 'both kinds of discount are kept');
      assert.deepEqual([saved.taxSnapshot!.netAmount, saved.taxSnapshot!.vatAmount, saved.taxSnapshot!.grossAmount], [240.2, 45.64, 285.84]);
      const { xml } = await exportInvoice(invoice.id);
      const lines = blocks(xml, 'ram:IncludedSupplyChainTradeLineItem');
      const lineFacts = lines.map((line) => {
        const allowance = blocks(line, 'ram:SpecifiedTradeAllowanceCharge')[0] ?? '';
        return [Number(first(line, 'ram:ChargeAmount')), Number(first(allowance, 'ram:ActualAmount')), first(allowance, 'udt:Indicator'), Number(first(line, 'ram:LineTotalAmount'))];
      });
      assert.deepEqual(lineFacts, [[89, 17.8, 'false', 160.2], [100, 20, 'false', 80]]);
      const monetary = blocks(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')[0]!;
      assert.equal(Number(first(monetary, 'ram:LineTotalAmount')), 240.2);
      assert.equal(Number(first(monetary, 'ram:GrandTotalAmount')), 285.84);
    });

    test('a seller in Austria or Switzerland puts its own country code into the XML', async () => {
      await configureLite(h.api, { eInvoice: true, countryCode: 'AT' });
      try {
        const invoice = await issueDated(h.api, { client: 'AT Verkäufer', date: '2026-06-22', servicePeriod: '2026-06-22', items: [line('Leistung', 10, 19)] });
        const { xml } = await exportInvoice(invoice.id);
        assert.equal(first(blocks(xml, 'ram:SellerTradeParty')[0]!, 'ram:CountryID'), 'AT');
      } finally {
        await configureLite(h.api, { eInvoice: true, countryCode: 'DE' });
      }
    });

    test('totals stay consistent for many odd amounts: tax groups add up to the tax total, gross = net + VAT (BR-CO-14/15/10)', async () => {
      let seed = 20260617;
      const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const mismatches: string[] = [];
      for (let n = 0; n < 12; n += 1) {
        const items = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => {
          const quantity = 1 + Math.floor(random() * 5);
          const price = round2(1 + random() * 200);
          return { kind: 'item' as const, description: `Position ${n}.${i}`, quantity, price, total: round2(quantity * price), taxRate: random() < 0.5 ? 19 : 7 };
        });
        const invoice = await issueDated(h.api, { client: `Zufall ${n}`, date: '2026-06-23', servicePeriod: '2026-06-23', items });
        const { xml } = await exportInvoice(invoice.id);
        const snapshot = (await stored(invoice.id)).taxSnapshot!;
        const monetary = blocks(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')[0]!;
        const groups = headerTaxes(xml);
        const linesNet = round2(blocks(xml, 'ram:IncludedSupplyChainTradeLineItem').reduce((sum, l) => sum + Number(first(l, 'ram:LineTotalAmount')), 0));
        const where = `#${n} ${JSON.stringify(items.map((i) => [i.total, i.taxRate]))}`;
        if (round2(groups.reduce((sum, g) => sum + g.calculated, 0)) !== Number(first(monetary, 'ram:TaxTotalAmount'))) mismatches.push(`${where}: groups ${groups.map((g) => g.calculated)} vs tax total ${first(monetary, 'ram:TaxTotalAmount')}`);
        if (Number(first(monetary, 'ram:TaxTotalAmount')) !== snapshot.vatAmount) mismatches.push(`${where}: tax total vs snapshot ${snapshot.vatAmount}`);
        if (round2(Number(first(monetary, 'ram:TaxBasisTotalAmount')) + Number(first(monetary, 'ram:TaxTotalAmount'))) !== Number(first(monetary, 'ram:GrandTotalAmount'))) mismatches.push(`${where}: grand total`);
        if (linesNet !== Number(first(monetary, 'ram:LineTotalAmount'))) mismatches.push(`${where}: line sum ${linesNet} vs ${first(monetary, 'ram:LineTotalAmount')}`);
        if (Number(first(monetary, 'ram:GrandTotalAmount')) !== snapshot.grossAmount) mismatches.push(`${where}: grand total vs snapshot ${snapshot.grossAmount}`);
      }
      assert.deepEqual(mismatches, []);
    });
  });

  describe('when no e-invoice is produced, or the export must fail', () => {
    test('offers and invoices with e-invoicing switched off are exported without XML', async () => {
      const offer = await draftOffer(h.api, { client: 'Angebot Kunde' });
      const preparedOffer = await prepare('offer', offer.id);
      assert.equal(preparedOffer.finalize, undefined);
      assert.match(preparedOffer.suggestedName, /^Angebot-/);
      await configureLite(h.api, { eInvoice: false });
      try {
        const invoice = await issueDated(h.api, { client: 'Ohne E-Rechnung', date: '2026-06-24', servicePeriod: '2026-06-24', items: [line('Leistung', 10, 19)] });
        assert.equal((await prepare('invoice', invoice.id)).finalize, undefined);
      } finally {
        await configureLite(h.api, { eInvoice: true });
      }
    });

    test('an incomplete seller address stops the invoice already when it is issued', async () => {
      await configureLite(h.api, { eInvoice: true, street: '' });
      try {
        await assert.rejects(issueDated(h.api, { client: 'Seller Check', date: '2026-06-25', servicePeriod: '2026-06-25', items: [line('Leistung', 10, 19)] }), /Anschrift deines Unternehmens/);
      } finally {
        await configureLite(h.api, { eInvoice: true });
      }
      const later = await issueDated(h.api, { client: 'Seller Check 2', date: '2026-06-25', servicePeriod: '2026-06-25', items: [line('Leistung', 10, 19)] });
      assert.ok((await prepare('invoice', later.id)).finalize, 'a complete profile works again');
    });

    test('a buyer address without street or postal code stops the export', async () => {
      const draft = await draftInvoice(h.api, { client: 'Adresse unvollständig', items: [line('Leistung', 10, 19)] });
      const incomplete = await h.api.invoices.upsert({ reason: 'Adresse ohne PLZ', invoice: { ...draft, clientAddress: 'Hauptstraße 1\nBerlin', status: 'open' } });
      await assert.rejects(prepare('invoice', incomplete.id), /Pflichtfeld "Käufer PLZ"/);
      // Without any address the invoice is not issued at all (§14 Abs. 4 Nr. 1 UStG).
      await assert.rejects(h.api.invoices.upsert({ reason: 'Ohne Adresse', invoice: { ...(await draftInvoice(h.api, { client: 'Ohne Adresse' })), clientAddress: '', status: 'open' } }), /Anschrift des Kunden fehlt/);
    });

    test('a buyer address typed in one line ("Straße, PLZ Ort") is split into street, postal code and city', async () => {
      const draft = await draftInvoice(h.api, { client: 'Einzeilig GmbH', items: [line('Leistung', 10, 19)] });
      const issued = await h.api.invoices.upsert({ reason: 'einzeilige Adresse', invoice: { ...draft, clientAddress: 'Musterstrasse 123, 12345 Musterstadt', billingAddressJson: undefined, status: 'open' } as never });
      const { xml } = await exportInvoice(issued.id);
      const buyer = blocks(xml, 'ram:BuyerTradeParty')[0]!;
      assert.deepEqual([first(buyer, 'ram:LineOne'), first(buyer, 'ram:PostcodeCode'), first(buyer, 'ram:CityName')], ['Musterstrasse 123', '12345', 'Musterstadt']);
    });

    test('a buyer address that cannot be read names the fix and the way to a normal PDF', async () => {
      const draft = await draftInvoice(h.api, { client: 'Ohne PLZ', items: [line('Leistung', 10, 19)] });
      const incomplete = await h.api.invoices.upsert({ reason: 'Adresse ohne PLZ', invoice: { ...draft, clientAddress: 'Hauptstraße 1\nBerlin', status: 'open' } });
      await assert.rejects(prepare('invoice', incomplete.id), /Käufer PLZ.*Kundenadresse.*ZUGFeRD.*ausschalten/s);
    });

    test('an invoice with nothing billable is not issued, so there is no e-invoice', async () => {
      const draft = await draftInvoice(h.api, { client: 'Nur Text', items: [{ kind: 'text', description: 'Nur ein Hinweis', quantity: 0, price: 0, total: 0 }] });
      await assert.rejects(h.api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...draft, status: 'open' } }), /Position mit Betrag/);
    });

    test('an unknown document and a corrupt PDF fail instead of producing a half-embedded file', async () => {
      await assert.rejects(prepare('invoice', 'does-not-exist'));
      const invoice = await issueDated(h.api, { client: 'Corrupt PDF', date: '2026-06-27', servicePeriod: '2026-06-27', items: [line('Leistung', 10, 19)] });
      const prepared = await prepare('invoice', invoice.id);
      await assert.rejects(prepared.finalize!(new Uint8Array([1, 2, 3, 4])));
    });
  });

  describe('EN 16931 details a validator checks', () => {
    let exported: Awaited<ReturnType<typeof exportInvoice>>;
    before(async () => {
      const invoice = await issueDated(h.api, { client: 'Validator GmbH', date: '2026-07-01', servicePeriod: '2026-07-01', taxMode: 'vat_exempt_4_ustg', taxMeta: { taxRuleConfirmed: true } as never, items: [line('Leistung', 100)] });
      exported = await exportInvoice(invoice.id);
    });

    test('a SEPA credit transfer (payment means 58) names the seller IBAN (BR-61)', () => {
      assert.ok(exported.xml.includes('<ram:TypeCode>58</ram:TypeCode>'));
      assert.ok(exported.xml.includes('DE02120300000000202051'), 'the IBAN of the settings');
    });

    test('ExemptionReason comes before BasisAmount in the VAT breakdown (CII schema order)', () => {
      const [group] = headerTaxes(exported.xml);
      assert.ok(group!.reason);
      assert.ok(group!.block.indexOf('<ram:ExemptionReason>') < group!.block.indexOf('<ram:BasisAmount>'));
      assert.ok(group!.block.indexOf('<ram:TypeCode>') < group!.block.indexOf('<ram:ExemptionReason>'));
    });

    test('line net prices are not negative: a discount is a document-level allowance (BR-27)', async () => {
      const invoice = await issueDated(h.api, { client: 'Rabatt Validator', date: '2026-07-02', servicePeriod: '2026-07-02', items: [line('Arbeit', 100, 19), line('Rabatt', -10, 19)] });
      const { xml } = await exportInvoice(invoice.id);
      assert.ok(blocks(xml, 'ram:IncludedSupplyChainTradeLineItem').every((l) => Number(first(l, 'ram:ChargeAmount')) >= 0));
    });

    test('an e-invoice states a seller tax identifier (VAT ID or tax number)', async () => {
      await configureLite(h.api, { eInvoice: true, vatId: '', taxId: '' });
      try {
        await assert.rejects(issueDated(h.api, { client: 'Seller ohne ID', date: '2026-07-03', servicePeriod: '2026-07-03', items: [line('Leistung', 10, 19)] }), /Steuernummer oder USt-IdNr\./);
      } finally {
        await configureLite(h.api, { eInvoice: true });
      }
    });
  });
});

const UBL_FIXTURE = new URL('./fixtures/xrechnung-ubl.xml', import.meta.url);
const XRECHNUNG_ID = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';
const base64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64');
const fromBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');
/** Seller contact XRechnung requires on top of the e-invoice profile (BR-DE-2/6/7). */
const withPhone = async (api: LiteHarness['api']) => {
  const settings = (await api.settings.get())!;
  await api.settings.set({ settings: { ...settings, company: { ...settings.company, phone: '+49 30 1234567' } } });
};
/** An issued invoice for a public buyer: Leitweg-ID and billing e-mail set. */
const issueForAuthority = async (api: LiteHarness['api'], over: Record<string, unknown> = {}) => {
  const draft = await draftInvoice(api, { client: 'Stadt Musterhausen', clientEmail: 'eingang@musterhausen.example', date: '2026-08-03', dueDate: '2026-08-17', items: [line('Wartung', 200, 19), line('Fachbuch', 30, 7)], taxMeta: { buyerReference: '04011000-12345-67' } as never, ...over });
  return api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...draft, servicePeriod: '2026-08-01', status: 'open' } });
};

describe('XRechnung export and e-invoice inbox (Lite)', () => {
  let h: LiteHarness;
  let prepare: ReturnType<typeof createDocumentExportPreparer>;
  before(async () => {
    h = await startLite(null, 'einvoice-xrechnung');
    await configureLite(h.api, { eInvoice: true });
    prepare = createDocumentExportPreparer({ product: 'lite', resolveConnection: () => h.connection });
  });
  after(async () => { await h.close(); });

  test('missing Leitweg-ID and seller phone: 422 naming each field; drafts and unknown ids are refused', async () => {
    const withoutReference = await issueDated(h.api, { client: 'Ohne Leitweg', date: '2026-08-01', servicePeriod: '2026-08-01', items: [line('Leistung', 100, 19)] });
    const refused = await h.raw('GET', `/documents/invoice/${withoutReference.id}/xrechnung`);
    assert.equal(refused.status, 422, refused.text);
    assert.match(refused.body.message, /^XRechnung nicht möglich, es fehlt: /);
    assert.match(refused.body.message, /Leitweg-ID\/Käuferreferenz \(BT-10\)/);
    assert.match(refused.body.message, /Telefonnummer deines Unternehmens \(BT-42\)/);
    assert.doesNotMatch(refused.body.message, /E-Mail des Kunden/, 'the buyer e-mail is there');
    await assert.rejects(h.api.documents.exportXRechnung({ id: withoutReference.id }), /Leitweg-ID/);

    await withPhone(h.api);
    const draft = await draftInvoice(h.api, { client: 'Entwurf Behörde', items: [line('Leistung', 100, 19)], taxMeta: { buyerReference: '991-1' } as never });
    const draftExport = await h.raw('GET', `/documents/invoice/${draft.id}/xrechnung`);
    assert.equal(draftExport.status, 422, draftExport.text);
    assert.match(draftExport.body.message, /Entwurf/);
    const noBuyerMail = await issueForAuthority(h.api, { clientEmail: '' });
    const mailRefused = await h.raw('GET', `/documents/invoice/${noBuyerMail.id}/xrechnung`);
    assert.equal(mailRefused.status, 422, mailRefused.text);
    assert.match(mailRefused.body.message, /E-Mail des Kunden \(BT-49\)/);
    assert.equal((await h.raw('GET', '/documents/invoice/does-not-exist/xrechnung')).status, 404);
  });

  test('round trip: the exported XRechnung reads back with number, totals, VAT, profile, BT-34/BT-49 and BG-6', async () => {
    await withPhone(h.api);
    const invoice = await issueForAuthority(h.api);
    const file = await h.api.documents.exportXRechnung({ id: invoice.id });
    assert.equal(file.fileName, `${invoice.number.replace(/[^\w.-]+/g, '_')}_xrechnung.xml`);
    assert.equal(file.mimeType, 'application/xml');
    const xml = fromBase64(file.contentBase64);
    assertWellFormed(xml);
    assert.equal(first(blocks(xml, 'ram:GuidelineSpecifiedDocumentContextParameter')[0]!, 'ram:ID'), XRECHNUNG_ID);
    const seller = blocks(xml, 'ram:SellerTradeParty')[0]!;
    const contact = blocks(seller, 'ram:DefinedTradeContact')[0]!;
    assert.equal(first(contact, 'ram:PersonName'), 'Max Muster', 'BT-41: the owner');
    assert.equal(first(contact, 'ram:CompleteNumber'), '+49 30 1234567', 'BT-42');
    assert.equal(first(contact, 'ram:URIID'), 'info@muster.example', 'BT-43');
    assert.ok(seller.includes('<ram:URIID schemeID="EM">info@muster.example</ram:URIID>'), 'BT-34');
    assert.ok(seller.indexOf('<ram:DefinedTradeContact>') < seller.indexOf('<ram:PostalTradeAddress>') && seller.indexOf('</ram:PostalTradeAddress>') < seller.indexOf('<ram:URIUniversalCommunication>'), 'CII order');
    assert.ok(blocks(xml, 'ram:BuyerTradeParty')[0]!.includes('<ram:URIID schemeID="EM">eingang@musterhausen.example</ram:URIID>'), 'BT-49');

    const parsed = await h.api.einvoice.parse({ fileName: file.fileName, contentBase64: file.contentBase64 });
    const stored = (await h.api.invoices.list()).find((entry) => entry.id === invoice.id)!;
    assert.equal(parsed.syntax, 'CII');
    assert.equal(parsed.profile, XRECHNUNG_ID);
    assert.equal(parsed.number, invoice.number);
    assert.equal(parsed.typeCode, '380');
    assert.equal(parsed.isCreditNote, false);
    assert.deepEqual([parsed.issueDate, parsed.dueDate, parsed.serviceDate], ['2026-08-03', '2026-08-17', '2026-08-01']);
    assert.equal(parsed.buyerReference, '04011000-12345-67');
    assert.equal(parsed.seller.email, 'info@muster.example');
    assert.equal(parsed.seller.vatId, 'DE123456789');
    assert.equal(parsed.iban, 'DE02120300000000202051');
    assert.deepEqual(parsed.totals, { net: stored.taxSnapshot!.netAmount, vat: stored.taxSnapshot!.vatAmount, gross: stored.taxSnapshot!.grossAmount, due: stored.taxSnapshot!.grossAmount });
    assert.deepEqual(parsed.vatBreakdown.map((g) => [g.category, g.rate, g.netAmount, g.vatAmount]).sort(), [['S', 19, 200, 38], ['S', 7, 30, 2.1]].sort());
    assert.deepEqual(parsed.lines.map((l) => [l.description, l.netAmount]), [['Wartung', 200], ['Fachbuch', 30]]);
    assert.deepEqual(parsed.warnings, []);

    // The ZUGFeRD PDF of the same invoice stays EN 16931 without XRechnung-only elements.
    const prepared = await prepare('invoice', invoice.id);
    const zugferd = xmlOf(await readFacturX(await prepared.finalize!(await blankPdf())));
    assert.equal(first(zugferd, 'ram:ID'), 'urn:cen.eu:en16931:2017');
    assert.ok(!zugferd.includes('DefinedTradeContact') && !zugferd.includes('URIUniversalCommunication') && !zugferd.includes('BusinessProcessSpecifiedDocumentContextParameter'));
  });

  test('a cancellation exports as XRechnung 381 and reads back as a credit note with the correction warning', async () => {
    await withPhone(h.api);
    const source = await issueForAuthority(h.api);
    const cancellation = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'cancellation_invoice', date: '2026-08-05', dueDate: '2026-08-05', reason: 'Storno' } as never);
    const file = await h.api.documents.exportXRechnung({ id: cancellation.id });
    const parsed = await h.api.einvoice.parse({ fileName: file.fileName, contentBase64: file.contentBase64 });
    assert.equal(parsed.typeCode, '381');
    assert.equal(parsed.isCreditNote, true);
    assert.ok(parsed.warnings.includes('Gutschrift – bitte als Korrekturbeleg erfassen.'));
  });

  test('the ZUGFeRD PDF export is read through its embedded factur-x.xml', async () => {
    const invoice = await issueDated(h.api, { client: 'PDF Leser GmbH', date: '2026-08-06', dueDate: '2026-08-20', servicePeriod: '2026-08-06', items: [line('Beratung', 99.99, 19)] });
    const prepared = await prepare('invoice', invoice.id);
    const pdf = await prepared.finalize!(await blankPdf());
    const parsed = await h.api.einvoice.parse({ fileName: 'rechnung.pdf', contentBase64: base64(pdf) });
    assert.deepEqual(parsed.source, { kind: 'pdf', attachmentName: 'factur-x.xml' });
    assert.equal(parsed.profile, 'urn:cen.eu:en16931:2017');
    assert.equal(parsed.number, invoice.number);
    assert.equal(parsed.seller.name, 'Muster Consulting');
    assert.equal(parsed.buyer.name, 'PDF Leser GmbH');
    assert.deepEqual(parsed.totals, { net: 99.99, vat: 19, gross: 118.99, due: 118.99 });
  });

  test('a hand-written UBL XRechnung: entities decoded, leading zeros kept, VAT per rate, payment data', async () => {
    const xml = await readFile(UBL_FIXTURE);
    const parsed = await h.api.einvoice.parse({ fileName: 'xrechnung-ubl.xml', contentBase64: base64(xml) });
    assert.equal(parsed.syntax, 'UBL');
    assert.equal(parsed.profile, XRECHNUNG_ID);
    assert.deepEqual([parsed.number, parsed.typeCode, parsed.issueDate, parsed.dueDate, parsed.serviceDate], ['0815-2026-17', '380', '2026-03-10', '2026-03-24', '2026-03-05']);
    assert.deepEqual(parsed.period, { start: '2026-03-01', end: '2026-03-05' });
    assert.equal(parsed.buyerReference, '991-01234-56');
    assert.deepEqual(parsed.seller, { name: 'Bürobedarf Schulz & Partner GmbH', vatId: 'DE987654321', street: 'Papierweg 7', zip: '04109', city: 'Leipzig', country: 'DE', email: 'rechnung@schulz-partner.example' });
    assert.deepEqual([parsed.iban, parsed.bic, parsed.paymentReference], ['DE75512108001245126199', 'SOGEDEFFXXX', '0815-2026-17']);
    assert.deepEqual(parsed.vatBreakdown, [{ category: 'S', rate: 19, netAmount: 100, vatAmount: 19 }, { category: 'S', rate: 7, netAmount: 20, vatAmount: 1.4 }]);
    assert.deepEqual(parsed.totals, { net: 120, vat: 20.4, gross: 140.4, due: 140.4 });
    assert.deepEqual(parsed.lines.map((l) => [l.description, l.quantity, l.unit, l.netPrice, l.netAmount, l.vatRate]), [['Druckerpapier A4, 5 000 Blatt', 2, 'H87', 50, 100, 19], ['Fachbuch Buchhaltung', 1, 'H87', 20, 20, 7]]);
    assert.deepEqual(parsed.notes, ['Vielen Dank für Ihren Auftrag & bis bald.']);
    assert.deepEqual(parsed.warnings, []);
  });

  test('hostile and wrong input: DOCTYPE/ENTITY refused (400), no e-invoice (422), bad request (400)', async () => {
    const xxe = '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<rsm:CrossIndustryInvoice xmlns:rsm="urn:x"><a>&x;</a></rsm:CrossIndustryInvoice>';
    const refused = await h.raw('POST', '/einvoice/parse', { fileName: 'xxe.xml', contentBase64: base64(xxe) });
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.body.message, /DOCTYPE/);
    assert.ok(!refused.text.includes('root:'), 'nothing of the file leaks');

    const plainPdf = await h.raw('POST', '/einvoice/parse', { fileName: 'scan.pdf', contentBase64: base64(await blankPdf()) });
    assert.equal(plainPdf.status, 422, plainPdf.text);
    assert.match(plainPdf.body.message, /^Keine E-Rechnung gefunden: .*eingebettete Rechnung/);
    for (const [fileName, content, reason] of [
      ['notiz.txt', 'Hallo, das ist keine Rechnung.', /weder PDF noch XML/],
      ['bestellung.xml', '<?xml version="1.0"?><Order><ID>1</ID></Order>', /weder eine CII-Rechnung/],
      ['kaputt.xml', '<rsm:CrossIndustryInvoice><a></rsm:CrossIndustryInvoice>', /nicht wohlgeformt/],
      ['kaputt.pdf', '%PDF-1.7 kein echtes PDF', /PDF-Datei konnte nicht gelesen werden/],
    ] as const) {
      const response = await h.raw('POST', '/einvoice/parse', { fileName, contentBase64: base64(content) });
      assert.equal(response.status, 422, `${fileName}: ${response.text}`);
      assert.match(response.body.message, reason, fileName);
    }
    assert.equal((await h.raw('POST', '/einvoice/parse', { fileName: 'x.xml', contentBase64: '***' })).status, 400, 'bad base64');
    assert.equal((await h.raw('POST', '/einvoice/parse', { contentBase64: base64('<a/>') })).status, 400, 'no file name');
  });
});

describe('XRechnung export and e-invoice inbox (Pro)', () => {
  let h: ProHarness;
  before(async () => {
    h = await startPro(null, 'einvoice-xrechnung-pro');
    await configureLite(h.api as never, { eInvoice: true });
    await withPhone(h.api as never);
  });
  after(async () => { await h.close(); });

  test('Pro reads the UBL sample and exports an XRechnung of an issued invoice', async () => {
    const parsed = await h.api.einvoice.parse({ fileName: 'xrechnung-ubl.xml', contentBase64: base64(await readFile(UBL_FIXTURE)) });
    assert.equal(parsed.number, '0815-2026-17');
    assert.equal(parsed.totals.gross, 140.4);
    const invoice = await issueInvoice(h.api as never, { client: 'Behörde Pro', items: [line('Leistung', 100, 19)], taxMeta: { buyerReference: '991-77' } as never });
    const file = await h.api.documents.exportXRechnung({ id: invoice.id });
    const back = await h.api.einvoice.parse({ fileName: file.fileName, contentBase64: file.contentBase64 });
    assert.equal(back.profile, XRECHNUNG_ID);
    assert.equal(back.number, invoice.number);
    assert.equal(back.buyerReference, '991-77');
    assert.equal(back.totals.gross, 119);
  });
});
