



import { Invoice, Client, Article, AppSettings, Account, RecurringProfile } from '../types';

export const MOCK_SETTINGS: AppSettings = {
  portal: {
    baseUrl: '',
  },
  eInvoice: {
    enabled: false,
    standard: 'zugferd-en16931',
    profile: 'EN16931',
    version: '2.3',
  },
  catalog: {
    categories: [
      { id: 'cat-webdesign', name: 'Webdesign' },
      { id: 'cat-consulting', name: 'Consulting' },
      { id: 'cat-dev', name: 'Entwicklung' },
      { id: 'cat-hosting', name: 'Hosting' },
    ],
  },
  company: {
    name: 'Mustermann GmbH',
    owner: 'Max Mustermann',
    street: 'Musterstraße 123',
    zip: '10115',
    city: 'Berlin',
    email: 'info@mustermann-gmbh.de',
    phone: '+49 30 1234567',
    website: 'www.mustermann-gmbh.de'
  },
  finance: {
    bankName: 'Berliner Sparkasse',
    iban: 'DE12 1005 0000 1234 5678 90',
    bic: 'BELA DE BE XXX',
    taxId: '12/345/67890',
    vatId: 'DE123456789',
    registerCourt: 'Amtsgericht Charlottenburg HRB 12345'
  },
  numbers: {
    invoicePrefix: 'RE-%Y-',
    nextInvoiceNumber: 104,
    numberLength: 3,
    offerPrefix: 'ANG-%Y-',
    nextOfferNumber: 42,
    customerPrefix: 'KD-',
    nextCustomerNumber: 4,
    customerNumberLength: 4,
  },
  dunning: {
    levels: [
      {
        id: 1,
        name: 'Zahlungserinnerung',
        enabled: true,
        daysAfterDueDate: 7,
        fee: 0,
        subject: 'Zahlungserinnerung zur Rechnung %N',
        text: 'Sicherlich haben Sie in der Hektik des Alltags übersehen, unsere Rechnung %N vom %D zu begleichen. Wir bitten Sie, den fälligen Betrag innerhalb der nächsten 7 Tage zu überweisen.'
      },
      {
        id: 2,
        name: '1. Mahnung',
        enabled: true,
        daysAfterDueDate: 14,
        fee: 2.50,
        subject: '1. Mahnung zur Rechnung %N',
        text: 'Leider konnten wir bisher keinen Zahlungseingang für die Rechnung %N feststellen. Bitte überweisen Sie den fälligen Betrag zzgl. der Mahngebühr umgehend.'
      },
      {
        id: 3,
        name: '2. Mahnung',
        enabled: true,
        daysAfterDueDate: 21,
        fee: 5.00,
        subject: 'Letzte Mahnung zur Rechnung %N',
        text: 'Dies ist die letzte Aufforderung, die offene Forderung zur Rechnung %N zu begleichen, bevor wir das gerichtliche Mahnverfahren einleiten.'
      }
    ]
  },
  legal: {
    smallBusinessRule: false,
    defaultVatRate: 19,
    taxAccountingMethod: 'soll',
    paymentTermsDays: 14,
    defaultIntroText: 'Vielen Dank für Ihren Auftrag. Wir stellen Ihnen folgende Leistungen in Rechnung:',
    defaultFooterText: 'Es gelten unsere Allgemeinen Geschäftsbedingungen.'
  },
  email: {
    provider: 'none',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: true,
    smtpUser: '',
    fromName: '',
    fromEmail: ''
  },
  automation: {
    dunningEnabled: false,
    dunningRunTime: '09:00',
    recurringEnabled: true,
    recurringRunTime: '03:00'
  },
  dashboard: {
    monthlyRevenueGoal: 30000,
    dueSoonDays: 7,
    topCategoriesLimit: 5,
    recentPaymentsLimit: 5,
    topClientsLimit: 5,
  }
};

export const MOCK_RECURRING_PROFILES: RecurringProfile[] = [
    {
        id: 'rec1',
        clientId: 'c1',
        active: true,
        name: 'Wartungsvertrag Website',
        interval: 'monthly',
        nextRun: '2023-11-01',
        lastRun: '2023-10-01',
        amount: 150.00,
        items: [
            { description: 'Monatliche Wartungspauschale', quantity: 1, price: 150.00, total: 150.00 }
        ]
    },
    {
        id: 'rec2',
        clientId: 'c2',
        active: true,
        name: 'Hosting Paket Pro',
        interval: 'yearly',
        nextRun: '2024-01-01',
        lastRun: '2023-01-01',
        amount: 340.00,
        items: [
            { description: 'Hosting Gebühr 2024', quantity: 1, price: 340.00, total: 340.00 }
        ]
    },
    {
        id: 'rec3',
        clientId: 'c1',
        active: false,
        name: 'SEO Retainer Q4',
        interval: 'monthly',
        nextRun: '2023-11-15',
        amount: 850.00,
        items: [
            { description: 'SEO Optimierung', quantity: 10, price: 85.00, total: 850.00 }
        ]
    }
];

export const MOCK_CLIENTS: Client[] = [
  {
    id: 'c1',
    customerNumber: 'KD-0001',
    company: 'Musterfirma GmbH',
    contactPerson: 'Max Mustermann',
    email: 'buchhaltung@musterfirma.de',
    phone: '+49 30 12345678',
    address: 'Musterstraße 123, 12345 Musterstadt',
    status: 'active',
    tags: ['VIP', 'Software'],
    notes: 'Kunde legt Wert auf hohe Qualität. Zahlungsziel immer 14 Tage.',
    projects: [
      { id: 'p1', name: 'Website Relaunch 2024', status: 'active', budget: 15000, startDate: '2023-09-01', description: 'Kompletter Relaunch der Corporate Website.' },
      { id: 'p2', name: 'SEO Kampagne Q4', status: 'completed', budget: 2500, startDate: '2023-10-01', endDate: '2023-12-31' }
    ],
    activities: [
      { id: 'a1', type: 'call', date: '2023-11-10T10:00:00', author: 'Ich', content: 'Telko bezüglich neuen Anforderungen für das Dashboard.' },
      { id: 'a2', type: 'email', date: '2023-11-05T14:30:00', author: 'System', content: 'Rechnung #RE-2023-001 versendet.' },
      { id: 'a3', type: 'meeting', date: '2023-10-20T09:00:00', author: 'Ich', content: 'Kickoff-Meeting für Phase 2.' }
    ]
  },
  {
    id: 'c2',
    customerNumber: 'KD-0002',
    company: 'StartUp Berlin AG',
    contactPerson: 'Julia Design',
    email: 'hello@startup-berlin.io',
    phone: '+49 170 9876543',
    address: 'Torstraße 5, 10119 Berlin',
    status: 'active',
    tags: ['Startup', 'Design'],
    notes: 'Schnelles Wachstum, unstrukturierte Prozesse.',
    projects: [
      { id: 'p3', name: 'App Design System', status: 'on_hold', budget: 8000, startDate: '2023-08-15' }
    ],
    activities: [
      { id: 'a4', type: 'email', date: '2023-10-21T09:15:00', author: 'System', content: 'Angebot #AG-23-055 akzeptiert.' }
    ]
  },
  {
    id: 'c3',
    customerNumber: 'KD-0003',
    company: 'Handwerk Müller',
    contactPerson: 'Klaus Müller',
    email: 'info@handwerk-mueller.de',
    phone: '+49 89 555222',
    address: 'Handwerkerweg 9, 80331 München',
    status: 'inactive',
    tags: ['Late Payer'],
    notes: 'Zahlt oft spät, Mahnwesen beachten.',
    projects: [],
    activities: [
        { id: 'a5', type: 'note', date: '2023-09-15T11:00:00', author: 'Ich', content: 'Mahnstufe 1 eingeleitet.' }
    ]
  }
];

export const MOCK_INVOICES: Invoice[] = [
  {
    id: '1',
    clientId: 'c1',
    clientNumber: 'KD-0001',
    number: 'RE-2023-001',
    client: 'Musterfirma GmbH',
    clientEmail: 'buchhaltung@musterfirma.de',
    clientAddress: 'Musterstraße 123\n12345 Musterstadt',
    date: '2023-10-15',
    dueDate: '2023-10-29',
    servicePeriod: '2023-10-15',
    taxMode: 'standard_vat',
    amount: 1250.00,
    status: 'paid',
    dunningLevel: 0,
    items: [
      { description: 'Webdesign Entwurf', quantity: 1, price: 850.00, total: 850.00 },
      { description: 'Frontend Entwicklung', quantity: 5, price: 80.00, total: 400.00 }
    ],
    payments: [
      { id: 'p1', date: '2023-10-28', amount: 1250.00, method: 'Banküberweisung' }
    ],
    history: [
      { date: '2023-10-15', action: 'Rechnung erstellt' },
      { date: '2023-10-16', action: 'Per E-Mail versendet' },
      { date: '2023-10-28', action: 'Zahlung vollständig erhalten' }
    ]
  },
  {
    id: '2',
    clientId: 'c2',
    clientNumber: 'KD-0002',
    number: 'RE-2023-002',
    client: 'StartUp Berlin AG',
    clientEmail: 'hello@startup-berlin.io',
    date: '2023-10-20',
    dueDate: '2023-11-03',
    servicePeriod: '10.2023',
    taxMode: 'standard_vat',
    amount: 3450.50,
    status: 'open',
    dunningLevel: 0,
    items: [
      { description: 'Consulting Workshop', quantity: 1, price: 1200.00, total: 1200.00 },
      { description: 'Strategiepapier', quantity: 1, price: 1500.00, total: 1500.00 },
      { description: 'Reisekosten', quantity: 1, price: 200.00, total: 200.00 } 
    ],
    payments: [],
    history: [
      { date: '2023-10-20', action: 'Rechnung erstellt' },
      { date: '2023-10-20', action: 'Per E-Mail versendet' }
    ]
  },
  {
    id: '3',
    clientId: 'c3',
    clientNumber: 'KD-0003',
    number: 'RE-2023-003',
    client: 'Handwerk Müller',
    clientEmail: 'info@handwerk-mueller.de',
    date: '2023-09-01',
    dueDate: '2023-09-15',
    servicePeriod: '08.2023',
    taxMode: 'standard_vat',
    amount: 450.00,
    status: 'overdue',
    dunningLevel: 1,
    items: [
      { description: 'Wartung Server', quantity: 3, price: 150.00, total: 450.00 }
    ],
    payments: [],
    history: [
      { date: '2023-09-01', action: 'Rechnung erstellt' },
      { date: '2023-09-16', action: 'Zahlungserinnerung gesendet' },
      { date: '2023-10-01', action: 'Mahnung Stufe 1' }
    ]
  },
  {
    id: '4',
    clientId: '',
    number: 'ENTWURF-001',
    client: 'Unbekannt',
    clientEmail: '',
    date: '2023-10-26',
    dueDate: '',
    servicePeriod: '',
    taxMode: 'standard_vat',
    amount: 0.00,
    status: 'draft',
    dunningLevel: 0,
    items: [],
    payments: [],
    history: [
      { date: '2023-10-26', action: 'Entwurf angelegt' }
    ]
  }
];

export const MOCK_ARTICLES: Article[] = [
  {
    id: 'a1',
    sku: 'DEV-001',
    title: 'Senior Entwicklung',
    description: 'Stundensatz für Senior Software Entwicklung (Frontend/Backend)',
    price: 120.00,
    unit: 'Std',
    category: 'Dienstleistung',
    taxRate: 19
  },
  {
    id: 'a2',
    sku: 'DES-005',
    title: 'Webdesign Pauschale S',
    description: 'Design einer Landingpage inkl. 2 Korrekturschleifen',
    price: 1500.00,
    unit: 'Pauschale',
    category: 'Design',
    taxRate: 19
  },
  {
    id: 'a3',
    sku: 'HST-101',
    title: 'Server Wartung',
    description: 'Monatliche Wartung, Updates und Backup-Überprüfung',
    price: 85.00,
    unit: 'Monat',
    category: 'Hosting',
    taxRate: 19
  },
  {
    id: 'a4',
    sku: 'CON-200',
    title: 'Beratung',
    description: 'Consulting und Strategieberatung',
    price: 150.00,
    unit: 'Std',
    category: 'Consulting',
    taxRate: 19
  },
  {
    id: 'a5',
    sku: 'MSC-000',
    title: 'Anfahrt',
    description: 'Anfahrtspauschale im Stadtgebiet',
    price: 45.00,
    unit: 'Pauschale',
    category: 'Sonstiges',
    taxRate: 19
  }
];

export const MOCK_ACCOUNTS: Account[] = [
  { 
    id: 'acc1', 
    name: 'Hauptgeschäftskonto', 
    iban: 'DE12 3456 7890 1234 5678 90', 
    balance: 124500.00, 
    type: 'bank',
    color: 'bg-white',
    transactions: [
      { id: 't1', date: '2023-10-28', amount: 1250.00, type: 'income', counterparty: 'Musterfirma GmbH', purpose: 'Rechnung RE-2023-001', linkedInvoiceId: '1', status: 'booked' },
      { id: 't2', date: '2023-10-27', amount: -49.90, type: 'expense', counterparty: 'Adobe Systems', purpose: 'Creative Cloud Abo', status: 'booked' },
      { id: 't3', date: '2023-10-25', amount: 3450.50, type: 'income', counterparty: 'StartUp Berlin AG', purpose: 'Gutschrift', status: 'booked' }, // Unlinked
      { id: 't4', date: '2023-10-24', amount: -250.00, type: 'expense', counterparty: 'DB Vertrieb GmbH', purpose: 'BahnCard 50 Business', status: 'booked' },
      { id: 't5', date: '2023-10-20', amount: -12.99, type: 'expense', counterparty: 'Google Workspace', purpose: 'Monatliche Gebühr', status: 'booked' },
    ]
  },
  { 
    id: 'acc2', 
    name: 'Steuerrücklagen', 
    iban: 'DE99 8877 6655 4433 2211 00', 
    balance: 45000.00, 
    type: 'bank',
    color: 'bg-gray-50',
    transactions: [
        { id: 't6', date: '2023-10-01', amount: 5000.00, type: 'income', counterparty: 'Umbuchung Hauptkonto', purpose: 'Rücklage Q3', status: 'booked' }
    ]
  },
  { 
    id: 'acc3', 
    name: 'PayPal Business', 
    iban: 'paypal@firma.de', 
    balance: 3420.00, 
    type: 'paypal',
    color: 'bg-blue-50',
    transactions: [
        { id: 't7', date: '2023-10-23', amount: 850.00, type: 'income', counterparty: 'Online Shop Kunde', purpose: 'Bestellung #992', status: 'booked' },
        { id: 't8', date: '2023-10-22', amount: -120.00, type: 'expense', counterparty: 'Hosting Provider', purpose: 'Server Miete', status: 'booked' }
    ]
  },
];
