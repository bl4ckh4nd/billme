
import { ElementType, InvoiceElement, ElementStyle } from './types';

// A4 width in pixels at 96 DPI is approx 794px.
// We will use mm to px conversion roughly: 1mm = 3.78px
export const A4_WIDTH_PX = 794;
export const A4_HEIGHT_PX = 1123;
export const MM_TO_PX = 3.78;

export const DEFAULT_TEXT_STYLE: ElementStyle = {
  fontSize: 14,
  fontWeight: 'normal',
  textAlign: 'left',
  color: '#000000',
  width: 200,
  height: 30,
};

// DIN 5008 Form B Zones (Standard for Window Envelopes)
// Coordinates in PX
export const DIN_ZONES = [
  { label: 'Absenderzeile (Fenster)', x: 20 * MM_TO_PX, y: 45 * MM_TO_PX, width: 85 * MM_TO_PX, height: 5 * MM_TO_PX },
  { label: 'Anschriftenfeld (Fenster)', x: 20 * MM_TO_PX, y: 50 * MM_TO_PX, width: 85 * MM_TO_PX, height: 40 * MM_TO_PX },
  { label: 'Faltmarke 1', x: 0, y: 105 * MM_TO_PX, width: 10 * MM_TO_PX, height: 1 },
  { label: 'Faltmarke 2', x: 0, y: 210 * MM_TO_PX, width: 10 * MM_TO_PX, height: 1 },
  { label: 'Lochmarke', x: 0, y: 148.5 * MM_TO_PX, width: 10 * MM_TO_PX, height: 1 },
];

// Based on DIN 5008 B (roughly) for German Standards
export const INITIAL_INVOICE_TEMPLATE: InvoiceElement[] = [
  // --- Header ---
  {
    id: 'company_name',
    type: ElementType.TEXT,
    x: 120 * MM_TO_PX, // Top Right for logo/name usually
    y: 20 * MM_TO_PX,
    zIndex: 10,
    content: '{{my.name}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 24, fontWeight: 'bold', width: 250, color: '#111111', textAlign: 'right' },
    label: 'sender_company'
  },
  
  // --- Address Field Area ---
  // Small Sender Line (Backaddress) - Mandatory in Germany for window envelopes
  {
    id: 'sender_line',
    type: ElementType.TEXT,
    x: 20 * MM_TO_PX, // Standard Left Margin
    y: 45 * MM_TO_PX, // DIN Position
    zIndex: 10,
    content: '{{my.address_line}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 8, color: '#666666', width: 320, textDecoration: 'underline' },
    label: 'sender_line'
  },
  // Recipient Address
  {
    id: 'recipient_address',
    type: ElementType.TEXT,
    x: 20 * MM_TO_PX,
    y: 50 * MM_TO_PX, // DIN Position
    zIndex: 10,
    content: '{{client.company}}\n{{client.address}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 11, width: 320, height: 150, color: '#000000' },
    label: 'recipient_block'
  },

  // --- Invoice Meta Block (Right Side) ---
  {
    id: 'invoice_info',
    type: ElementType.TEXT,
    x: 125 * MM_TO_PX, // Right side block
    y: 50 * MM_TO_PX, // Aligned with address block
    zIndex: 10,
    content: 'Rechnungs-Nr: {{invoice.number}}\nDatum: {{invoice.date}}\nLeistungsdatum: {{invoice.servicePeriod}}\nKunden-Nr: {{client.number}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 11, textAlign: 'right', width: 250, height: 100, color: '#333333' },
    label: 'invoice_meta'
  },

  // --- Title & Intro ---
  {
    id: 'invoice_title',
    type: ElementType.TEXT,
    x: 20 * MM_TO_PX,
    y: 100 * MM_TO_PX,
    zIndex: 10,
    content: 'Rechnung {{invoice.number}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 20, fontWeight: 'bold', width: 700 },
    label: 'invoice_title'
  },
  {
    id: 'intro_text',
    type: ElementType.TEXT,
    x: 20 * MM_TO_PX,
    y: 115 * MM_TO_PX,
    zIndex: 10,
    content: 'Sehr geehrte Damen und Herren,\n\nvielen Dank für Ihren Auftrag. Wir berechnen Ihnen für unsere Leistungen wie folgt:',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 11, width: 700, height: 50 },
    label: 'intro_text'
  },

  // --- Main Table ---
  {
    id: 'main_table',
    type: ElementType.TABLE,
    x: 20 * MM_TO_PX,
    y: 135 * MM_TO_PX,
    zIndex: 10,
    style: { width: 170 * MM_TO_PX, fontSize: 11 },
    tableData: {
      columns: [
        { id: 'pos', label: 'Pos.', width: 40, visible: true, align: 'left' },
        { id: 'desc', label: 'Bezeichnung', width: 280, visible: true, align: 'left' },
        { id: 'qty', label: 'Menge', width: 60, visible: true, align: 'right' },
        { id: 'price', label: 'Einzelpreis', width: 90, visible: true, align: 'right' },
        { id: 'total', label: 'Gesamt', width: 90, visible: true, align: 'right' }
      ],
      rows: [
        { id: 'r1', cells: ['1', 'Beratung & Konzeption', '4 Std', '100,00 €', '400,00 €'] },
        { id: 'r2', cells: ['2', 'Entwicklung Webapplikation', '10 Std', '100,00 €', '1.000,00 €'] },
      ]
    },
    label: 'items_table'
  },

  // --- Totals ---
  {
    id: 'totals_block',
    type: ElementType.TEXT,
    x: 125 * MM_TO_PX,
    y: 180 * MM_TO_PX,
    zIndex: 10,
    content: 'Netto: {{total.net}}\nUSt ({{total.taxRate}}): {{total.tax}}\nGesamtbetrag: {{total.gross}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 11, textAlign: 'right', fontWeight: 'bold', width: 245, height: 80 },
    label: 'totals_block'
  },

  // --- Payment Terms / Footer Note ---
  {
    id: 'payment_terms',
    type: ElementType.TEXT,
    x: 20 * MM_TO_PX,
    y: 200 * MM_TO_PX,
    zIndex: 10,
    content: 'Bitte überweisen Sie den Betrag innerhalb von 14 Tagen ohne Abzug auf das unten genannte Konto.\nEs gelten unsere AGB.',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 10, width: 700, height: 50 },
    label: 'payment_terms'
  },

  // --- Footer Line ---
  {
    id: 'footer_line',
    type: ElementType.LINE,
    x: 20 * MM_TO_PX,
    y: 265 * MM_TO_PX,
    zIndex: 5,
    style: { width: 170 * MM_TO_PX, height: 1, backgroundColor: '#dddddd' }
  },

  // --- Split Footer Columns (Freely Placeable) ---
  {
    id: 'footer_company',
    type: ElementType.TEXT,
    x: 20 * MM_TO_PX,
    y: 270 * MM_TO_PX,
    zIndex: 10,
    content: '{{my.name}}\n{{my.street}}\n{{my.zip}} {{my.city}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 8, color: '#666666', width: 200, height: 60 },
    label: 'footer_company'
  },
  {
    id: 'footer_contact',
    type: ElementType.TEXT,
    x: 80 * MM_TO_PX,
    y: 270 * MM_TO_PX,
    zIndex: 10,
    content: 'Kontakt:\nTel: {{my.phone}}\nMail: {{my.email}}\nWeb: {{my.website}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 8, color: '#666666', width: 200, height: 60 },
    label: 'footer_contact'
  },
  {
    id: 'footer_bank',
    type: ElementType.TEXT,
    x: 140 * MM_TO_PX,
    y: 270 * MM_TO_PX,
    zIndex: 10,
    content: 'Bankverbindung:\nIBAN: {{my.iban}}\nBIC: {{my.bic}}\nSteuer-Nr.: {{my.taxId}}\nUSt-IdNr.: {{my.vatId}}',
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 8, color: '#666666', width: 200, height: 60 },
    label: 'footer_bank'
  }
];

export const INITIAL_OFFER_TEMPLATE: InvoiceElement[] = [
  // Copy most elements from Invoice but change text
  ...INITIAL_INVOICE_TEMPLATE.map(el => {
      // Modify Title
      if (el.label === 'invoice_title') {
          return { ...el, content: 'Angebot {{invoice.number}}' };
      }
      // Modify Intro
      if (el.label === 'intro_text') {
          return { ...el, content: 'Sehr geehrte Damen und Herren,\n\ngerne unterbreiten wir Ihnen freibleibend folgendes Angebot:' };
      }
      // Modify Meta Info (Replace Service Period with Valid Until if desired, or just generic date)
      if (el.label === 'invoice_meta') {
           return { ...el, content: 'Angebots-Nr: {{invoice.number}}\nDatum: {{invoice.date}}\nGültig bis: {{invoice.dueDate}}\nKunden-Nr: {{client.number}}' };
      }
      // Modify Terms
      if (el.label === 'payment_terms') {
           return { ...el, content: 'Wir freuen uns auf Ihre Auftragserteilung.\nBei Rückfragen stehen wir Ihnen gerne zur Verfügung.' };
      }
      return el;
  })
];

export const INITIAL_TEMPLATE = INITIAL_INVOICE_TEMPLATE; // Default fallback
