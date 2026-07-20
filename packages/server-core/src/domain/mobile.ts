import { z } from 'zod';
import { invoiceSchema, offerSchema } from './foundations.js';
import { serverProductSchema, serverRoleSchema } from '../shared/runtime-profile.js';

export const mobilePlatformSchema = z.enum(['ios', 'android']);
export type MobilePlatform = z.infer<typeof mobilePlatformSchema>;

export const mobileDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  platform: mobilePlatformSchema,
  product: serverProductSchema,
  lastActiveAt: z.string().min(1),
  createdAt: z.string().min(1),
  revokedAt: z.string().optional(),
});
export type MobileDevice = z.infer<typeof mobileDeviceSchema>;

export const mobileSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.string().min(1),
  refreshTokenExpiresAt: z.string().min(1),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    fullName: z.string().min(1),
    role: serverRoleSchema,
  }),
  tenantId: z.string().min(1),
  product: serverProductSchema,
  role: serverRoleSchema,
  device: mobileDeviceSchema,
});
export type MobileSession = z.infer<typeof mobileSessionSchema>;

export const mobileDeviceLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceName: z.string().trim().min(1).max(120),
  platform: mobilePlatformSchema,
});
export type MobileDeviceLoginRequest = z.infer<typeof mobileDeviceLoginRequestSchema>;

export const mobileSessionRefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const mobilePairingCodeSchema = z.object({
  code: z.string().min(16),
  expiresAt: z.string().min(1),
  pairingUri: z.string().url(),
});
export type MobilePairingCode = z.infer<typeof mobilePairingCodeSchema>;

export const mobilePairingExchangeRequestSchema = z.object({
  code: z.string().min(16),
  deviceName: z.string().trim().min(1).max(120),
  platform: mobilePlatformSchema,
});

export const mobilePushRegistrationSchema = z.object({
  token: z.string().min(1).max(4096),
  provider: z.enum(['expo', 'apns', 'fcm']).default('expo'),
});

export const mobileActionTypeSchema = z.enum([
  'overdue_invoice',
  'draft_document',
  'receipt_review',
  'booking_review',
  'offer_decision',
]);

export const mobileActionItemSchema = z.object({
  id: z.string().min(1),
  type: mobileActionTypeSchema,
  title: z.string().min(1),
  detail: z.string().min(1),
  amount: z.number().optional(),
  dueAt: z.string().optional(),
  severity: z.enum(['neutral', 'attention', 'urgent']),
  route: z.string().min(1),
});
export type MobileActionItem = z.infer<typeof mobileActionItemSchema>;

export const mobileHomeSchema = z.object({
  serverTime: z.string().min(1),
  summary: z.object({
    openReceivables: z.number(),
    overdueReceivables: z.number(),
    draftDocuments: z.number().int().nonnegative(),
    receiptsToReview: z.number().int().nonnegative(),
    bookingReviews: z.number().int().nonnegative(),
  }),
  actions: z.array(mobileActionItemSchema),
  recentActivity: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().min(1),
    occurredAt: z.string().min(1),
    route: z.string().min(1),
  })).max(20),
});
export type MobileHome = z.infer<typeof mobileHomeSchema>;

export const receiptStatusSchema = z.enum(['queued', 'processing', 'needs_review', 'confirmed', 'failed']);
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;

const receiptFieldSuggestionSchema = <T extends z.ZodTypeAny>(value: T) => z.object({
  value: value.nullable(),
  confidence: z.number().min(0).max(1),
  sourceText: z.string().optional(),
});

export const receiptSuggestionSchema = z.object({
  merchant: receiptFieldSuggestionSchema(z.string()),
  invoiceNumber: receiptFieldSuggestionSchema(z.string()),
  date: receiptFieldSuggestionSchema(z.string()),
  currency: receiptFieldSuggestionSchema(z.string().length(3)),
  grossAmount: receiptFieldSuggestionSchema(z.number()),
  netAmount: receiptFieldSuggestionSchema(z.number()),
  vatAmount: receiptFieldSuggestionSchema(z.number()),
  suggestedAccountNumber: receiptFieldSuggestionSchema(z.string()).optional(),
  rawText: z.string().optional(),
});
export type ReceiptSuggestion = z.infer<typeof receiptSuggestionSchema>;

export const receiptSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  product: serverProductSchema,
  originalName: z.string().min(1),
  mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  byteSize: z.number().int().positive().max(15 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: receiptStatusSchema,
  storageKey: z.string().min(1),
  suggestion: receiptSuggestionSchema.optional(),
  confirmedAt: z.string().optional(),
  failureCode: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Receipt = z.infer<typeof receiptSchema>;

export const receiptUploadMetadataSchema = z.object({
  id: z.string().uuid(),
  originalName: z.string().trim().min(1).max(255),
  mimeType: receiptSchema.shape.mimeType,
  sha256: receiptSchema.shape.sha256,
});

export const receiptConfirmRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  suggestion: receiptSuggestionSchema,
});

export const documentDeliveryStatusSchema = z.enum(['queued', 'rendering', 'sending', 'sent', 'failed']);
export const documentDeliverySchema = z.object({
  id: z.string().min(1),
  documentType: z.enum(['invoice', 'offer']),
  documentId: z.string().min(1),
  status: documentDeliveryStatusSchema,
  recipientEmail: z.string().email(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  sentAt: z.string().optional(),
  errorCode: z.string().optional(),
  attemptCount: z.number().int().nonnegative().default(0),
});
export type DocumentDelivery = z.infer<typeof documentDeliverySchema>;

const mobileInvoiceDraftSchema = invoiceSchema.omit({
  tenantId: true,
  number: true,
  createdAt: true,
  updatedAt: true,
});
const mobileOfferDraftSchema = offerSchema.omit({
  tenantId: true,
  number: true,
  createdAt: true,
  updatedAt: true,
});

export const mobileDocumentFinalizeRequestSchema = z.object({
  clientMutationId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  draft: z.discriminatedUnion('kind', [mobileInvoiceDraftSchema, mobileOfferDraftSchema]),
  delivery: z.object({
    recipientEmail: z.string().email(),
    recipientName: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(300),
    bodyText: z.string().trim().min(1).max(20_000),
  }).optional(),
});

export const mobileDocumentFinalizeResponseSchema = z.object({
  document: z.union([invoiceSchema, offerSchema]),
  delivery: documentDeliverySchema.optional(),
  replayed: z.boolean(),
});
export type MobileDocumentFinalizeResponse = z.infer<typeof mobileDocumentFinalizeResponseSchema>;
