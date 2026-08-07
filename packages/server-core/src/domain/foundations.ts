import { z } from 'zod';
import { deploymentModeSchema, serverProductSchema, serverRoleSchema, type ServerProduct } from '../shared/runtime-profile.js';

const nonEmptyStringSchema = z.string().trim().min(1);

export const entityIdSchema = nonEmptyStringSchema;
export type EntityId = z.infer<typeof entityIdSchema>;

export const isoDateSchema = nonEmptyStringSchema;
export type IsoDate = z.infer<typeof isoDateSchema>;

export const isoDateTimeSchema = nonEmptyStringSchema;
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

export const lifecycleTimestampsSchema = z.object({
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LifecycleTimestamps = z.infer<typeof lifecycleTimestampsSchema>;

export const billingEntityTypeSchema = z.enum([
  'tenant',
  'user-account',
  'tenant-membership',
  'client',
  'invoice',
  'offer',
  'recurring-profile',
]);
export type BillingEntityType = z.infer<typeof billingEntityTypeSchema>;

export const tenantScopeSchema = z.object({
  tenantId: entityIdSchema,
  product: serverProductSchema,
  deploymentMode: deploymentModeSchema.default('single-tenant'),
});
export type TenantScope = z.infer<typeof tenantScopeSchema>;

export const createSingleTenantScope = (tenantId: string, product: ServerProduct): TenantScope => {
  return tenantScopeSchema.parse({
    tenantId,
    product,
    deploymentMode: 'single-tenant',
  });
};

export const tenantStatusSchema = z.enum(['provisioning', 'active', 'suspended', 'archived']);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const tenantSchema = z.object({
  id: entityIdSchema,
  slug: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  product: serverProductSchema,
  deploymentMode: deploymentModeSchema.default('single-tenant'),
  status: tenantStatusSchema.default('active'),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Tenant = z.infer<typeof tenantSchema>;

export const userAccountStatusSchema = z.enum(['invited', 'active', 'disabled']);
export type UserAccountStatus = z.infer<typeof userAccountStatusSchema>;

export const userAccountSchema = z.object({
  id: entityIdSchema,
  email: z.string().email(),
  fullName: nonEmptyStringSchema,
  status: userAccountStatusSchema.default('active'),
  lastLoginAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type UserAccount = z.infer<typeof userAccountSchema>;

export const tenantMembershipSchema = z.object({
  id: entityIdSchema,
  tenantId: entityIdSchema,
  userId: entityIdSchema,
  role: serverRoleSchema,
  invitedByUserId: entityIdSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TenantMembership = z.infer<typeof tenantMembershipSchema>;

export const billingAddressSchema = z.object({
  company: z.string().optional(),
  contactPerson: z.string().optional(),
  street: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});
export type BillingAddress = z.infer<typeof billingAddressSchema>;

export const invoiceTaxModeSchema = z.enum([
  'standard_vat',
  'small_business_19_ustg',
  'reverse_charge_13b',
  'intra_eu_supply_6a',
  'intra_eu_service_reverse_charge',
  'export_third_country',
  'vat_exempt_4_ustg',
  'non_taxable_outside_scope',
]);
export type InvoiceTaxMode = z.infer<typeof invoiceTaxModeSchema>;

export const invoiceTaxMetaSchema = z.object({
  legalReference: z.string().optional(),
  exemptionReasonOverride: z.string().optional(),
  buyerVatId: z.string().optional(),
  sellerVatId: z.string().optional(),
  /** Optional document-level rate. Position rates remain explicit exceptions. */
  defaultVatRate: z.number().min(0).max(100).optional(),
  buyerCountryCode: z.string().length(2).optional(),
  sellerCountryCode: z.string().length(2).optional(),
  buyerType: z.enum(['business', 'consumer']).optional(),
  /** `valid`/`invalid` are VIES results; unavailable can be overridden with a reason. */
  vatIdValidation: z.enum(['valid', 'invalid', 'unavailable', 'manual_override']).optional(),
  vatIdValidationAt: isoDateTimeSchema.optional(),
  taxRuleConfirmed: z.boolean().optional(),
});
export type InvoiceTaxMeta = z.infer<typeof invoiceTaxMetaSchema>;

export const invoiceTaxSnapshotSchema = z.object({
  vatRateApplied: z.number(),
  vatAmount: z.number(),
  netAmount: z.number(),
  grossAmount: z.number(),
  einvoiceCategoryCode: z.enum(['S', 'E', 'AE', 'O', 'K', 'G']),
  label: z.string().optional(),
  vatBreakdown: z.array(z.object({
    rate: z.number(),
    netAmount: z.number(),
    vatAmount: z.number(),
  })).optional(),
  taxNotice: z.string().optional(),
  taxRuleConfirmed: z.boolean().optional(),
});
export type InvoiceTaxSnapshot = z.infer<typeof invoiceTaxSnapshotSchema>;

export const invoiceTaxModeDefinitionSchema = z.object({
  mode: invoiceTaxModeSchema,
  label: z.string(),
  description: z.string(),
  legalReference: z.string().optional(),
  einvoiceCategoryCode: z.enum(['S', 'E', 'AE', 'O', 'K', 'G']),
  requiresBuyerVatId: z.boolean().optional(),
  requiresExemptionReason: z.boolean().optional(),
  forceZeroVat: z.boolean().optional(),
});
export type InvoiceTaxModeDefinition = z.infer<typeof invoiceTaxModeDefinitionSchema>;

export const clientAddressKindSchema = z.enum(['billing', 'shipping', 'other']);
export type ClientAddressKind = z.infer<typeof clientAddressKindSchema>;

export const clientAddressSchema = z.object({
  id: entityIdSchema,
  clientId: entityIdSchema,
  label: nonEmptyStringSchema,
  kind: clientAddressKindSchema,
  company: z.string().optional(),
  contactPerson: z.string().optional(),
  street: z.string(),
  line2: z.string().optional(),
  zip: z.string(),
  city: z.string(),
  country: z.string().default('DE'),
  isDefaultBilling: z.boolean().default(false),
  isDefaultShipping: z.boolean().default(false),
});
export type ClientAddress = z.infer<typeof clientAddressSchema>;

export const clientEmailKindSchema = z.enum(['general', 'billing', 'shipping', 'other']);
export type ClientEmailKind = z.infer<typeof clientEmailKindSchema>;

export const clientEmailSchema = z.object({
  id: entityIdSchema,
  clientId: entityIdSchema,
  label: nonEmptyStringSchema,
  kind: clientEmailKindSchema,
  email: z.string().email(),
  isDefaultGeneral: z.boolean().default(false),
  isDefaultBilling: z.boolean().default(false),
});
export type ClientEmail = z.infer<typeof clientEmailSchema>;

export const clientProjectStatusSchema = z.enum(['active', 'completed', 'planned', 'on_hold', 'inactive', 'archived']);
export type ClientProjectStatus = z.infer<typeof clientProjectStatusSchema>;

export const clientProjectSchema = z.object({
  id: entityIdSchema,
  clientId: entityIdSchema,
  code: z.string().optional(),
  name: nonEmptyStringSchema,
  status: clientProjectStatusSchema,
  budget: z.number(),
  startDate: isoDateSchema,
  endDate: isoDateSchema.optional(),
  description: z.string().optional(),
  archivedAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema.optional(),
});
export type ClientProject = z.infer<typeof clientProjectSchema>;

export const clientActivityTypeSchema = z.enum(['note', 'email', 'call', 'meeting']);
export type ClientActivityType = z.infer<typeof clientActivityTypeSchema>;

export const clientActivitySchema = z.object({
  id: entityIdSchema,
  clientId: entityIdSchema,
  type: clientActivityTypeSchema,
  content: nonEmptyStringSchema,
  date: isoDateSchema,
  author: nonEmptyStringSchema,
});
export type ClientActivity = z.infer<typeof clientActivitySchema>;

export const clientStatusSchema = z.enum(['active', 'inactive']);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const clientSchema = z.object({
  id: entityIdSchema,
  tenantId: entityIdSchema,
  customerNumber: z.string().optional(),
  company: nonEmptyStringSchema,
  contactPerson: z.string(),
  email: z.string(),
  phone: z.string(),
  address: z.string(),
  status: clientStatusSchema,
  avatar: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().default(''),
  addresses: z.array(clientAddressSchema).default([]),
  emails: z.array(clientEmailSchema).default([]),
  projects: z.array(clientProjectSchema).default([]),
  activities: z.array(clientActivitySchema).default([]),
  taxProfile: z.object({
    type: z.enum(['business', 'consumer']).default('business'),
    countryCode: z.string().length(2).optional(),
    vatId: z.string().optional(),
    vatIdValidation: z.enum(['valid', 'invalid', 'unavailable', 'manual_override']).optional(),
    vatIdValidationAt: isoDateTimeSchema.optional(),
  }).optional(),
  createdAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema.optional(),
});
export type Client = z.infer<typeof clientSchema>;

export const billingLineItemSchema = z.object({
  description: nonEmptyStringSchema,
  quantity: z.number(),
  price: z.number(),
  total: z.number(),
  articleId: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  taxRate: z.number().min(0).optional(),
});
export type BillingLineItem = z.infer<typeof billingLineItemSchema>;

export const paymentSchema = z.object({
  id: entityIdSchema,
  date: isoDateSchema,
  amount: z.number(),
  method: nonEmptyStringSchema,
});
export type Payment = z.infer<typeof paymentSchema>;

export const documentHistoryEntrySchema = z.object({
  date: isoDateSchema,
  action: nonEmptyStringSchema,
});
export type DocumentHistoryEntry = z.infer<typeof documentHistoryEntrySchema>;

export const offerDecisionSchema = z.enum(['accepted', 'declined']);
export type OfferDecision = z.infer<typeof offerDecisionSchema>;

export const offerShareSchema = z.object({
  token: z.string().optional(),
  publishedAt: isoDateTimeSchema.optional(),
  decision: offerDecisionSchema.optional(),
  decisionTextVersion: z.string().optional(),
  acceptedAt: isoDateTimeSchema.optional(),
  acceptedBy: z.string().optional(),
  acceptedEmail: z.string().optional(),
  acceptedUserAgent: z.string().optional(),
});
export type OfferShare = z.infer<typeof offerShareSchema>;

export const billingDocumentBaseSchema = z.object({
  id: entityIdSchema,
  tenantId: entityIdSchema,
  clientId: entityIdSchema.optional(),
  clientNumber: z.string().optional(),
  projectId: entityIdSchema.optional(),
  number: nonEmptyStringSchema,
  client: nonEmptyStringSchema,
  clientEmail: z.string(),
  clientAddress: z.string().optional(),
  billingAddress: billingAddressSchema.optional(),
  shippingAddress: billingAddressSchema.optional(),
  taxMode: invoiceTaxModeSchema.default('standard_vat'),
  taxMeta: invoiceTaxMetaSchema.optional(),
  taxSnapshot: invoiceTaxSnapshotSchema.optional(),
  date: isoDateSchema,
  amount: z.number(),
  items: z.array(billingLineItemSchema).default([]),
  history: z.array(documentHistoryEntrySchema).default([]),
  createdAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema.optional(),
});
export type BillingDocumentBase = z.infer<typeof billingDocumentBaseSchema>;

export const invoiceStatusSchema = z.enum(['paid', 'open', 'overdue', 'draft', 'cancelled']);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const invoiceSchema = billingDocumentBaseSchema.extend({
  kind: z.literal('invoice'),
  dueDate: isoDateSchema,
  servicePeriod: z.string().optional(),
  status: invoiceStatusSchema,
  dunningLevel: z.number().int().nonnegative().optional(),
  payments: z.array(paymentSchema).default([]),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const offerStatusSchema = z.enum(['draft', 'open', 'accepted', 'declined', 'expired', 'cancelled']);
export type OfferStatus = z.infer<typeof offerStatusSchema>;

export const offerSchema = billingDocumentBaseSchema.extend({
  kind: z.literal('offer'),
  validUntil: isoDateSchema,
  status: offerStatusSchema,
  share: offerShareSchema.optional(),
});
export type Offer = z.infer<typeof offerSchema>;

export const recurringIntervalSchema = z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']);
export type RecurringInterval = z.infer<typeof recurringIntervalSchema>;

export const recurringProfileSchema = z.object({
  id: entityIdSchema,
  tenantId: entityIdSchema,
  clientId: entityIdSchema,
  active: z.boolean(),
  name: nonEmptyStringSchema,
  interval: recurringIntervalSchema,
  nextRun: isoDateSchema,
  lastRun: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  amount: z.number(),
  items: z.array(billingLineItemSchema).default([]),
  taxMode: invoiceTaxModeSchema.default('standard_vat'),
  taxMeta: invoiceTaxMetaSchema.optional(),
  createdAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema.optional(),
});
export type RecurringProfile = z.infer<typeof recurringProfileSchema>;

export const normalizeEmailAddress = (value: string): string => value.trim().toLowerCase();
