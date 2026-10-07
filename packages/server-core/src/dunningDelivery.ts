import { z } from 'zod';
import type { AccountingMutationContext, DunningHistoryEntryDraft, DunningLevel, Invoice, TenantScope } from './index.js';

export const dunningDeliverySchema = z.object({ id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), level: z.number().int(), state: z.enum(['preparing', 'sending', 'sent', 'failed', 'unknown']), fee: z.number(), updatedAt: z.string(), error: z.string().optional() });
export const resolveDunningDeliverySchema = z.object({ id: z.string().min(1), accepted: z.boolean(), reason: z.string().trim().min(1) });
export type DunningDelivery = z.infer<typeof dunningDeliverySchema>;
export interface DunningDeliveryPort {
  claim(scope: TenantScope, invoiceId: string, level: DunningLevel): Promise<{ delivery: DunningDelivery; invoice: Invoice } | null>;
  begin(scope: TenantScope, id: string): Promise<boolean>;
  finish(scope: TenantScope, id: string, history: DunningHistoryEntryDraft, mutation: AccountingMutationContext): Promise<number>;
  fail(scope: TenantScope, id: string, error: string): Promise<void>;
}
