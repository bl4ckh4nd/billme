import { z } from 'zod';
import { entityIdSchema, isoDateTimeSchema } from './foundations.js';

export const queuedEmailDocumentTypeSchema = z.enum(['invoice', 'offer']);
export type QueuedEmailDocumentType = z.infer<typeof queuedEmailDocumentTypeSchema>;

export const queuedEmailProviderSchema = z.enum(['smtp', 'resend']);
export type QueuedEmailProvider = z.infer<typeof queuedEmailProviderSchema>;

export const emailOutboxStatusSchema = z.enum(['pending', 'processing', 'sent', 'failed']);
export type EmailOutboxStatus = z.infer<typeof emailOutboxStatusSchema>;

export const queueEmailDeliveryInputSchema = z.object({
  dedupeKey: z.string().trim().min(1).optional(),
  documentType: queuedEmailDocumentTypeSchema,
  documentId: entityIdSchema,
  documentNumber: z.string().min(1),
  recipientEmail: z.string().email(),
  recipientName: z.string().min(1),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  attachmentStorageKey: z.string().min(1).optional(),
  deliveryId: entityIdSchema.optional(),
  maxAttempts: z.number().int().positive().max(20).optional(),
  nextAttemptAt: isoDateTimeSchema.optional(),
});
export type QueueEmailDeliveryInput = z.infer<typeof queueEmailDeliveryInputSchema>;

export const emailOutboxEntrySchema = z.object({
  id: entityIdSchema,
  tenantId: entityIdSchema,
  dedupeKey: z.string().min(1),
  documentType: queuedEmailDocumentTypeSchema,
  documentId: entityIdSchema,
  documentNumber: z.string().min(1),
  recipientEmail: z.string().email(),
  recipientName: z.string().min(1),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  attachmentStorageKey: z.string().min(1).optional(),
  deliveryId: entityIdSchema.optional(),
  status: emailOutboxStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: isoDateTimeSchema,
  lastAttemptAt: isoDateTimeSchema.optional(),
  lockedAt: isoDateTimeSchema.optional(),
  leaseExpiresAt: isoDateTimeSchema.optional(),
  lockedBy: z.string().min(1).optional(),
  lastError: z.string().min(1).optional(),
  provider: queuedEmailProviderSchema.optional(),
  providerMessageId: z.string().min(1).optional(),
  sentAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EmailOutboxEntry = z.infer<typeof emailOutboxEntrySchema>;

export const emailOutboxClaimArgsSchema = z.object({
  limit: z.number().int().positive().max(100),
  workerId: z.string().trim().min(1),
  now: isoDateTimeSchema,
  leaseExpiresAt: isoDateTimeSchema,
});
export type EmailOutboxClaimArgs = z.infer<typeof emailOutboxClaimArgsSchema>;

export const emailOutboxMarkSentArgsSchema = z.object({
  id: entityIdSchema,
  workerId: z.string().trim().min(1),
  sentAt: isoDateTimeSchema,
  provider: queuedEmailProviderSchema,
  providerMessageId: z.string().min(1).optional(),
});
export type EmailOutboxMarkSentArgs = z.infer<typeof emailOutboxMarkSentArgsSchema>;

export const emailOutboxMarkFailedArgsSchema = z.object({
  id: entityIdSchema,
  workerId: z.string().trim().min(1),
  failedAt: isoDateTimeSchema,
  provider: queuedEmailProviderSchema,
  error: z.string().min(1),
  retryAt: isoDateTimeSchema.optional(),
});
export type EmailOutboxMarkFailedArgs = z.infer<typeof emailOutboxMarkFailedArgsSchema>;
