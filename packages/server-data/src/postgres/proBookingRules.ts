import { createHash } from 'node:crypto';
import type { AccountingMutationContext, BookingDraftEntity } from '@billme/accounting-shared';
import type { AccountSuggestionContext } from '@billme/finance-intelligence';
import type { TenantScope } from '@billme/server-core';
import { appendWithClient } from './audit.js';
import { runInTransaction, type PostgresQueryable } from './connection.js';

/**
 * "Auf Bestand anwenden" and automatic posting for booking rules.
 *
 * A draft belongs to the engine while its lines and text still hash to the
 * fingerprint the engine stored and nobody moved it past "suggested". Anything
 * else (edited by hand, sent to review, approved) is protected. Posted entries
 * are never rewritten; the preview only names them as a Hinweis, because the
 * correction is Storno plus a new booking.
 */

export type RuleApplicationKind = 'new' | 'update' | 'protected' | 'posted';

export interface RuleApplicationSide {
  accountNumber?: string;
  taxCaseKey?: string;
  bookingText?: string;
  ruleNames?: string[];
}

export interface RuleApplicationRow {
  transactionId: string;
  date: string;
  counterparty: string;
  amount: number;
  kind: RuleApplicationKind;
  /** Why a row is protected or only a Hinweis. */
  note?: string;
  before: RuleApplicationSide;
  after: RuleApplicationSide;
}

export interface RuleApplicationPreview {
  hash: string;
  rows: RuleApplicationRow[];
  counts: Record<RuleApplicationKind, number>;
}

export interface RuleDraftHelpers {
  getDraft(db: PostgresQueryable, scope: TenantScope, transactionId: string): Promise<BookingDraftEntity | null>;
  saveDraft(db: PostgresQueryable, scope: TenantScope, draft: BookingDraftEntity, mutation?: AccountingMutationContext): Promise<BookingDraftEntity>;
  /** The draft the engine would write now, unsaved. */
  proposeDraft(db: PostgresQueryable, scope: TenantScope, row: Record<string, any>, context: AccountSuggestionContext): Promise<BookingDraftEntity & { autoPost?: boolean }>;
  loadContext(db: PostgresQueryable, scope: TenantScope): Promise<AccountSuggestionContext>;
  postDraft(scope: TenantScope, draftId: string, options: { postingDate?: string; mutation?: AccountingMutationContext }): Promise<{ issues: unknown[] }>;
}

export interface BookingRuleRepository {
  previewRuleApplication(scope: TenantScope): Promise<RuleApplicationPreview>;
  applyRules(scope: TenantScope, input: { previewHash: string; mutation: AccountingMutationContext }): Promise<{ updated: number }>;
  /** Posts lines whose account came from a rule with automatic posting. */
  autoPostAfterImport(scope: TenantScope, mutation: AccountingMutationContext): Promise<{ rules: number }>;
}

const q = async (db: PostgresQueryable, text: string, values: unknown[]): Promise<any[]> => (await db.query(text, values)).rows as any[];
const round = (value: number) => Math.round(Number(value) * 100) / 100;
const ENGINE_OWNED = new Set(['imported', 'suggested', 'incomplete']);

/** Hash of what the engine decides: text and lines (account, amounts, tax case). */
export const draftFingerprint = (draft: Pick<BookingDraftEntity, 'bookingText' | 'lines'>): string =>
  createHash('sha256')
    .update(JSON.stringify([draft.bookingText, draft.lines.map((line) => [line.accountNumber, round(line.debitAmount), round(line.creditAmount), line.taxCaseKey ?? null])]))
    .digest('hex')
    .slice(0, 24);

/** Engine-owned: fingerprint intact and still before review. */
export const draftIsEngineOwned = (draft: BookingDraftEntity): boolean =>
  Boolean(draft.ruleFingerprint) && draft.ruleFingerprint === draftFingerprint(draft) && ENGINE_OWNED.has(draft.workflowStatus);

const side = (draft: BookingDraftEntity, bankAccount: string): RuleApplicationSide => {
  const main = draft.lines.find((line) => line.taxCaseKey) ?? draft.lines.find((line) => line.accountNumber !== bankAccount);
  const ruleNames = draft.ruleTrace?.filter((entry) => entry.matched).map((entry) => entry.name);
  return { accountNumber: main?.accountNumber, taxCaseKey: main?.taxCaseKey, bookingText: draft.bookingText, ...(ruleNames?.length ? { ruleNames } : {}) };
};

const differs = (a: RuleApplicationSide, b: RuleApplicationSide) => a.accountNumber !== b.accountNumber || (a.taxCaseKey ?? null) !== (b.taxCaseKey ?? null) || a.bookingText !== b.bookingText;

export const createPostgresBookingRuleRepository = (db: PostgresQueryable, helpers: RuleDraftHelpers): BookingRuleRepository => {
  /** Rows plus the proposals behind them; `apply` reuses the proposals inside its transaction. */
  const compute = async (client: PostgresQueryable, scope: TenantScope) => {
    const t = scope.tenantId;
    const context = await helpers.loadContext(client, scope);
    const lines = await q(client,
      `SELECT bt.*, a.default_skr_account_number FROM bank_transactions bt LEFT JOIN accounts a ON a.id=bt.account_id AND a.tenant_id=bt.tenant_id
        WHERE bt.tenant_id=$1 AND bt.linked_invoice_id IS NULL ORDER BY bt.date, bt.id`, [t]);
    const rows: RuleApplicationRow[] = [];
    const proposals = new Map<string, BookingDraftEntity>();
    const fingerprints: unknown[] = [];
    for (const row of lines) {
      // Booked lines too: the preview names them as a Hinweis when a rule would book them differently now.
      const proposal = await helpers.proposeDraft(client, scope, { ...row, status: 'pending' }, context);
      if (!proposal.ruleTrace?.some((entry) => entry.matched)) continue;
      const existing = await helpers.getDraft(client, scope, row.id);
      const bank = String(row.default_skr_account_number ?? '');
      const after = side(proposal, bank);
      const base = { transactionId: row.id, date: row.date, counterparty: row.counterparty ?? '', amount: Number(row.amount), after };
      let kind: RuleApplicationKind;
      let note: string | undefined;
      if (row.status === 'booked' || existing?.workflowStatus === 'posted') {
        kind = 'posted';
        note = 'Schon gebucht. Ändern nur per Storno und neuer Buchung.';
      } else if (!existing) {
        kind = 'new';
      } else if (draftIsEngineOwned(existing)) {
        kind = 'update';
      } else {
        kind = 'protected';
        note = ENGINE_OWNED.has(existing.workflowStatus) ? 'Von Hand geändert' : 'Schon in Prüfung oder freigegeben';
      }
      const before = existing ? side(existing, bank) : {};
      if (kind !== 'new' && !differs(before, after)) continue;
      rows.push({ ...base, kind, ...(note ? { note } : {}), before });
      if (kind === 'new' || kind === 'update') proposals.set(row.id, proposal);
      fingerprints.push([row.id, kind, existing?.updatedAt ?? null, draftFingerprint(proposal)]);
    }
    const hash = createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex').slice(0, 24);
    const counts = { new: 0, update: 0, protected: 0, posted: 0 } as Record<RuleApplicationKind, number>;
    for (const row of rows) counts[row.kind] += 1;
    return { preview: { hash, rows, counts }, proposals };
  };

  return {
    async previewRuleApplication(scope) {
      return (await compute(db, scope)).preview;
    },

    async applyRules(scope, input) {
      const reason = input.mutation.reason?.trim();
      if (!reason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
      return runInTransaction(db, async (tx) => {
        const { preview, proposals } = await compute(tx, scope);
        if (preview.hash !== input.previewHash) throw Object.assign(new Error('RULE_PREVIEW_STALE'), { statusCode: 409 });
        for (const proposal of proposals.values()) await helpers.saveDraft(tx, scope, proposal, input.mutation);
        await appendWithClient(tx, scope, {
          occurredAt: new Date().toISOString(), action: 'apply_booking_rules', reason,
          actor: input.mutation.actor ?? { type: 'service', displayName: 'server-accounting' },
          subject: { entityType: 'booking_rules', entityId: preview.hash, tenantId: scope.tenantId },
          change: { after: { updated: proposals.size, counts: preview.counts } },
        });
        return { updated: proposals.size };
      }, { serializable: true });
    },

    async autoPostAfterImport(scope, mutation) {
      let rules = 0;
      const pending = await q(db, `SELECT id FROM bank_transactions WHERE tenant_id=$1 AND status<>'booked' AND linked_invoice_id IS NULL ORDER BY date, id`, [scope.tenantId]);
      // Loaded once: auto-post only follows a rule's account, which memory and Bayes never set.
      const context = await helpers.loadContext(db, scope);
      for (const { id } of pending) {
        const approved = await runInTransaction(db, async (tx) => {
          const row = (await q(tx, `SELECT bt.*, a.default_skr_account_number FROM bank_transactions bt LEFT JOIN accounts a ON a.id=bt.account_id AND a.tenant_id=bt.tenant_id WHERE bt.tenant_id=$1 AND bt.id=$2`, [scope.tenantId, id]))[0];
          const proposal = await helpers.proposeDraft(tx, scope, row, context);
          if (!proposal.autoPost) return null;
          const existing = await helpers.getDraft(tx, scope, id);
          if (existing && (!draftIsEngineOwned(existing) || draftFingerprint(existing) !== draftFingerprint(proposal))) return null;
          const saved = await helpers.saveDraft(tx, scope, existing ?? proposal, mutation);
          // Validation decides: a closed period or a blocking issue leaves the draft for manual work.
          if (saved.workflowStatus !== 'suggested') return null;
          return helpers.saveDraft(tx, scope, { ...saved, workflowStatus: 'approved' }, mutation);
        });
        if (approved && (await helpers.postDraft(scope, approved.id, { postingDate: approved.postingDate, mutation })).issues.length === 0) rules += 1;
      }
      return { rules };
    },
  };
};
