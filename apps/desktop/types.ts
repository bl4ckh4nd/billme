

// Designer element model — canonical definitions live in @billme/desktop-designer.
export { ElementType } from '@billme/desktop-designer/types';
export type {
  ElementStyle,
  TableColumn,
  TableRow,
  InvoiceElement,
  SnapGuide,
  DocumentTemplate,
  DocumentTemplateKind,
} from '@billme/desktop-designer/types';

export interface GenerationRequest {
  industry: string;
}

// --- Settings Types ---

export interface DunningLevel {
  id: number;
  name: string; // e.g. "Zahlungserinnerung"
  enabled: boolean; // Allow individual level control
  daysAfterDueDate: number; // Trigger after X days overdue
  fee: number;
  subject: string;
  text: string;
}

export interface AppSettings {
  company: {
    name: string;
    owner: string;
    street: string;
    zip: string;
    city: string;
    email: string;
    phone: string;
    website: string;
  };
  catalog: {
    categories: Array<{
      id: string;
      name: string;
    }>;
  };
  finance: {
    bankName: string;
    iban: string;
    bic: string;
    taxId: string; // Steuernummer
    vatId: string; // USt-IdNr
    registerCourt: string; // Amtsgericht
  };
  numbers: {
    invoicePrefix: string; // e.g. "RE-2023-"
    nextInvoiceNumber: number; // e.g. 104
    numberLength: number; // e.g. 3 for "001"
    offerPrefix: string;
    nextOfferNumber: number;
    customerPrefix: string;
    nextCustomerNumber: number;
    customerNumberLength: number;
  };
  dunning: {
    levels: DunningLevel[];
  };
  legal: {
    smallBusinessRule: boolean; // Kleinunternehmer §19
    defaultVatRate: number;
    taxAccountingMethod: 'soll' | 'ist'; // Soll-/Ist-Versteuerung (default: soll)
    paymentTermsDays: number;
    defaultIntroText: string;
    defaultFooterText: string;
  };
  portal: {
    baseUrl: string;
  };
  eInvoice: {
    enabled: boolean;
    standard: 'zugferd-en16931';
    profile: 'EN16931';
    version: '2.3';
  };
  email: {
    provider: 'smtp' | 'resend' | 'none';
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    // smtpPassword is stored in OS keychain as 'smtp.password'
    fromName: string;
    fromEmail: string;
    // resendApiKey is stored in OS keychain as 'resend.apiKey'
  };
  automation: {
    dunningEnabled: boolean;
    dunningRunTime: string; // HH:MM format, e.g., "09:00"
    lastDunningRun?: string; // ISO timestamp
    recurringEnabled: boolean; // Auto-generate recurring invoices
    recurringRunTime: string; // HH:MM format, e.g., "03:00"
    lastRecurringRun?: string; // ISO timestamp
  };
  dashboard: {
    monthlyRevenueGoal: number;
    dueSoonDays: number;
    topCategoriesLimit: number;
    recentPaymentsLimit: number;
    topClientsLimit: number;
  };
  onboardingCompleted?: boolean;
}

// --- Invoice Data Types ---

export type InvoiceStatus = 'paid' | 'open' | 'overdue' | 'draft' | 'cancelled';

export interface InvoiceItem {
  description: string;
  quantity: number;
  price: number;
  total: number;
  articleId?: string;
  category?: string;
  unit?: string;
  discountPercent?: number;
  taxRate?: number;
}

export interface Payment {
  id: string;
  date: string;
  amount: number;
  method: string;
}

export type InvoiceTaxMode =
  | 'standard_vat'
  | 'small_business_19_ustg'
  | 'reverse_charge_13b'
  | 'intra_eu_supply_6a'
  | 'intra_eu_service_reverse_charge'
  | 'export_third_country'
  | 'vat_exempt_4_ustg'
  | 'non_taxable_outside_scope';

export interface InvoiceTaxMeta {
  legalReference?: string;
  exemptionReasonOverride?: string;
  buyerVatId?: string;
  sellerVatId?: string;
}

export interface InvoiceTaxSnapshot {
  vatRateApplied: number;
  vatAmount: number;
  netAmount: number;
  grossAmount: number;
  einvoiceCategoryCode: 'S' | 'E' | 'AE' | 'O';
  label?: string;
  vatBreakdown?: Array<{ rate: number; netAmount: number; vatAmount: number }>;
}

export interface InvoiceTaxModeDefinition {
  mode: InvoiceTaxMode;
  label: string;
  description: string;
  legalReference?: string;
  einvoiceCategoryCode: 'S' | 'E' | 'AE' | 'O';
  requiresBuyerVatId?: boolean;
  requiresExemptionReason?: boolean;
  forceZeroVat?: boolean;
}

export interface Invoice {
  id: string;
  clientId?: string; // Link to Client
  clientNumber?: string;
  projectId?: string; // Link to Project (client_projects)
  number: string;
  numberReservationId?: string;
  client: string;
  clientEmail: string;
  clientAddress?: string;
  billingAddressJson?: unknown;
  shippingAddressJson?: unknown;
  taxMode?: InvoiceTaxMode;
  taxMeta?: InvoiceTaxMeta;
  taxSnapshot?: InvoiceTaxSnapshot;
  shareToken?: string | null;
  sharePublishedAt?: string | null;
  shareDecision?: 'accepted' | 'declined' | null;
  shareDecisionTextVersion?: string | null;
  acceptedAt?: string | null;
  acceptedBy?: string | null;
  acceptedEmail?: string | null;
  acceptedUserAgent?: string | null;
  date: string;
  dueDate: string;
  servicePeriod?: string; // Leistungsdatum/Zeitraum (Required for German invoices)
  amount: number;
  status: InvoiceStatus;
  dunningLevel?: number; // 0 = None, 1 = Level 1, etc.
  items: InvoiceItem[];
  payments: Payment[];
  history?: { date: string; action: string }[];
}

// --- Recurring Invoice Types ---

export type RecurrenceInterval = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurringProfile {
    id: string;
    clientId: string;
    active: boolean;
    name: string; // Internal name e.g. "Maintenance Contract ABC"
    interval: RecurrenceInterval;
    nextRun: string; // ISO Date
    lastRun?: string;
    endDate?: string;
    amount: number;
    items: InvoiceItem[]; // Template items
}

// --- CRM Data Types ---

export interface Activity {
  id: string;
  type: 'note' | 'email' | 'call' | 'meeting';
  content: string;
  date: string;
  author: string;
}

export interface Project {
  id: string;
  clientId?: string;
  code?: string; // e.g. "PRJ-2026-001"
  name: string;
  status: 'active' | 'completed' | 'planned' | 'on_hold' | 'inactive' | 'archived';
  budget: number;
  startDate: string;
  endDate?: string;
  description?: string;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ClientAddressKind = 'billing' | 'shipping' | 'other';

export interface ClientAddress {
  id: string;
  clientId: string;
  label: string;
  kind: ClientAddressKind;
  company?: string;
  contactPerson?: string;
  street: string;
  line2?: string;
  zip: string;
  city: string;
  country: string; // default "DE"
  isDefaultBilling?: boolean;
  isDefaultShipping?: boolean;
}

export type ClientEmailKind = 'general' | 'billing' | 'shipping' | 'other';

export interface ClientEmail {
  id: string;
  clientId: string;
  label: string;
  kind: ClientEmailKind;
  email: string;
  isDefaultGeneral?: boolean;
  isDefaultBilling?: boolean;
}

export interface Client {
  id: string;
  customerNumber?: string;
  company: string;
  contactPerson: string;
  email: string; // legacy / default billing email
  phone: string;
  address: string; // legacy / default billing address (formatted)
  status: 'active' | 'inactive';
  avatar?: string;
  tags: string[];
  notes: string; // Internal general notes
  projects: Project[];
  activities: Activity[];
  addresses?: ClientAddress[];
  emails?: ClientEmail[];
}

// --- Article/Product Types ---

export interface Article {
  id: string;
  sku?: string; // Artikelnummer
  title: string;
  description: string;
  price: number; // Net price
  unit: string; // e.g., 'Std', 'Stk', 'Pauschale'
  category: string;
  taxRate: number; // e.g. 19, 7, 0
}

// --- Finance Types ---

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  type: 'income' | 'expense';
  counterparty: string; // Sender or Receiver
  purpose: string;
  linkedInvoiceId?: string; // ID of the linked invoice if applicable
  status: 'pending' | 'booked' | 'open' | 'matched';
  accountId?: string;
  dedupHash?: string;
  importBatchId?: string;
}

export interface Account {
  id: string;
  name: string;
  iban: string;
  balance: number;
  transactions: Transaction[];
  type: 'bank' | 'paypal' | 'cash' | 'checking' | 'savings' | 'credit' | 'other';
  color: string; // Tailwind class mostly or hex
}

// --- Template Types (DocumentTemplate re-exported from @billme/desktop-designer above) ---
