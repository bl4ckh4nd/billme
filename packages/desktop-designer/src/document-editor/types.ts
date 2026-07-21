import type {
  InvoiceTaxMeta,
  InvoiceTaxMode,
  InvoiceTaxSnapshot,
} from '@billme/server-core/domain';
import type { TaxSettingsShape } from '@billme/server-core/services';
import type { AppSettingsLike } from '@billme/desktop-utils/placeholders';

export interface DraftItem {
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

export interface DocumentDraft {
  id: string;
  number: string;
  date: string;
  dueDate?: string;
  servicePeriod?: string;
  client: string;
  clientId?: string;
  clientNumber?: string;
  clientEmail: string;
  clientAddress?: string;
  projectId?: string;
  billingAddressJson?: unknown;
  shippingAddressJson?: unknown;
  taxMode?: InvoiceTaxMode;
  taxMeta?: InvoiceTaxMeta;
  taxSnapshot?: InvoiceTaxSnapshot;
  amount: number;
  items: DraftItem[];
  [key: string]: unknown;
}

interface ClientAddressLike {
  kind?: 'billing' | 'shipping' | 'other';
  company?: string;
  contactPerson?: string;
  street?: string;
  line2?: string;
  zip?: string;
  city?: string;
  country?: string;
  isDefaultBilling?: boolean;
  isDefaultShipping?: boolean;
}

interface ClientEmailLike {
  email: string;
  isDefaultGeneral?: boolean;
  isDefaultBilling?: boolean;
}

export interface ClientLike {
  id: string;
  customerNumber?: string;
  company: string;
  email?: string;
  address?: string;
  addresses?: ClientAddressLike[];
  emails?: ClientEmailLike[];
}

export interface ProjectLike {
  id: string;
  name: string;
  code?: string;
  archivedAt?: string;
}

export interface ArticleLike {
  id: string;
  sku?: string;
  title: string;
  price: number;
  unit: string;
  category: string;
  description?: string;
  taxRate: number;
}

export type SettingsLike = TaxSettingsShape & AppSettingsLike & {
  legal: TaxSettingsShape['legal'] & { paymentTermsDays?: number };
  catalog?: { categories?: Array<{ name: string }> };
};
