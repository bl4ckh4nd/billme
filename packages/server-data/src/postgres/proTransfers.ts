import type { AccountingMutationContext, BookingDraftEntity } from '@billme/accounting-shared';
import {
  matchTransfers,
  type TransferDecision,
  type TransferLevel,
  type TransferMatch,
  type TransferTransaction,
} from '@billme/finance-intelligence';
import type { TenantScope } from '@billme/server-core';
import { appendWithClient } from './audit.js';
import { runInTransaction, type PostgresQueryable, type PostgresTransactionClient } from './connection.js';

/**
 * Transfers between own financial accounts. Each side is an ordinary bank
 * draft whose counter account is Geldtransit (SKR03 1360 / SKR04 1460), so it
 * posts through the normal draft workflow and stays out of GuV/UStVA. A side
 * posted without a posted partner leaves an open 1460 balance.
 */

export interface ProBookingSettings {
  transferDetection: boolean;
  transferWindowDays: number;
  autoPostTransfers: boolean;
  autoPostRules: boolean;
  updatedAt?: string;
}

export interface ProBankTransferInfo {
  status: 'suggested' | 'confirmed';
  level: TransferLevel;
  reasons: string[];
  partnerAccountId?: string;
  partnerAccountName?: string;
  /** Ledger account of the partner's financial account, for showing the other side's booking. */
  partnerLedgerAccountNumber?: string;
  partnerTransactionId?: string;
}

export interface TransitCandidate {
  transactionId: string;
  accountId: string;
  accountName: string;
  date: string;
  amount: number;
  counterparty: string;
  purpose: string;
  days: number;
  outsideWindow: boolean;
}

export interface TransitOpenSide {
  transactionId: string;
  accountId: string;
  accountName: string;
  ledgerAccountNumber: string;
  date: string;
  amount: number;
  counterparty: string;
  purpose: string;
  entryNumber: number;
  postingDate: string;
  partnerAccountId?: string;
  partnerAccountName?: string;
  /** Confirmed partner whose own side is not posted yet. */
  partnerTransactionId?: string;
  candidates: TransitCandidate[];
}

export interface TransitOverview {
  transitAccountNumber: string;
  months: Array<{ period: string; debit: number; credit: number; balance: number; cumulative: number }>;
  openBalance: number;
  openSides: TransitOpenSide[];
}

/** Internals of the draft repository the transfer actions reuse, so drafts stay validated in one place. */
export interface TransferDraftHelpers {
  getDraft(db: PostgresQueryable, scope: TenantScope, transactionId: string): Promise<BookingDraftEntity | null>;
  createDraft(db: PostgresQueryable, scope: TenantScope, transactionId: string): Promise<BookingDraftEntity | null>;
  saveDraft(db: PostgresQueryable, scope: TenantScope, draft: BookingDraftEntity, mutation?: AccountingMutationContext): Promise<BookingDraftEntity>;
  roleAccounts(db: PostgresQueryable, scope: TenantScope): Promise<Record<string, string>>;
}

export interface TransferRepository {
  getBookingSettings(scope: TenantScope): Promise<ProBookingSettings>;
  saveBookingSettings(scope: TenantScope, input: Partial<ProBookingSettings> & { mutation: AccountingMutationContext }): Promise<ProBookingSettings>;
  confirmTransfer(scope: TenantScope, input: { transactionId: string; partnerTransactionId?: string; mutation: AccountingMutationContext }): Promise<BookingDraftEntity[]>;
  rejectTransfer(scope: TenantScope, input: { transactionId: string; mutation: AccountingMutationContext }): Promise<void>;
  getTransitOverview(scope: TenantScope): Promise<TransitOverview>;
}

const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const now = (): string => new Date().toISOString();
const round = (n: unknown): number => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const cents = (n: unknown): number => Math.round(Number(n) * 100);
const fail = (code: string, statusCode = 409) => Object.assign(new Error(code), { statusCode });
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const DEFAULT_SETTINGS: ProBookingSettings = { transferDetection: true, transferWindowDays: 7, autoPostTransfers: false, autoPostRules: false };
/** Candidates for an open Geldtransit side are offered up to this far apart; beyond the window they are marked as such. */
const OPEN_SIDE_SEARCH_DAYS = 31;

export const loadBookingSettings = async (db: PostgresQueryable, tenantId: string): Promise<ProBookingSettings> => {
  const row = (await q(db, `SELECT * FROM pro_booking_settings WHERE tenant_id=$1`, [tenantId]))[0];
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    transferDetection: Boolean(row.transfer_detection),
    transferWindowDays: Number(row.transfer_window_days),
    autoPostTransfers: Boolean(row.auto_post_transfers),
    autoPostRules: Boolean(row.auto_post_rules),
    updatedAt: row.updated_at,
  };
};

export interface TransferState {
  settings: ProBookingSettings;
  accountNames: Map<string, string>;
  accountLedger: Map<string, string>;
  matches: Map<string, TransferMatch>;
}

/**
 * Current transfer matches of a tenant. Open bank lines take part, and booked
 * lines only when they were posted against Geldtransit: a line booked as an
 * expense is settled and must not attract a partner.
 */
export const loadTransferState = async (db: PostgresQueryable, scope: TenantScope, transitAccount: string): Promise<TransferState> => {
  const t = scope.tenantId;
  const settings = await loadBookingSettings(db, t);
  const accounts = await q(db, `SELECT id,name,iban,default_skr_account_number FROM accounts WHERE tenant_id=$1`, [t]);
  const rows = await q(db,
    `SELECT bt.id,bt.account_id,bt.date,bt.amount,bt.counterparty,bt.purpose,bt.counterparty_iban
       FROM bank_transactions bt
      WHERE bt.tenant_id=$1 AND bt.linked_invoice_id IS NULL
        AND (bt.status<>'booked' OR EXISTS (
          SELECT 1 FROM booking_drafts bd
            JOIN journal_entries je ON je.source_draft_id=bd.id AND je.tenant_id=bd.tenant_id AND je.status='posted'
            JOIN journal_lines jl ON jl.entry_id=je.id AND jl.tenant_id=je.tenant_id AND jl.account_number=$2
           WHERE bd.tenant_id=bt.tenant_id AND bd.transaction_id=bt.id))`,
    [t, transitAccount]);
  const links = await q(db, `SELECT * FROM bank_transfer_links WHERE tenant_id=$1`, [t]);
  const transactions: TransferTransaction[] = rows.map((row) => ({
    id: row.id, accountId: row.account_id, date: row.date, amount: Number(row.amount),
    counterparty: row.counterparty ?? '', purpose: row.purpose ?? '', counterpartyIban: row.counterparty_iban,
  }));
  const decisions: TransferDecision[] = links.map((link) => ({
    transactionId: link.transaction_id, status: link.status, partnerTransactionId: link.partner_transaction_id,
    level: link.level, reasons: JSON.parse(link.reasons_json || '[]'),
  }));
  const all = matchTransfers(transactions, accounts.map((a) => ({ id: a.id, name: a.name, iban: a.iban })), { windowDays: settings.transferWindowDays, decisions });
  const matches = settings.transferDetection ? all : new Map([...all].filter(([, match]) => match.status === 'confirmed'));
  return { settings, accountNames: new Map(accounts.map((a) => [a.id, a.name])), accountLedger: new Map(accounts.filter((a) => a.default_skr_account_number).map((a) => [a.id, a.default_skr_account_number])), matches };
};

export const transferInfo = (state: TransferState, transactionId: string): ProBankTransferInfo | undefined => {
  const match = state.matches.get(transactionId);
  if (!match) return undefined;
  return {
    status: match.status, level: match.level, reasons: match.reasons,
    partnerAccountId: match.partnerAccountId,
    partnerAccountName: match.partnerAccountId ? state.accountNames.get(match.partnerAccountId) : undefined,
    partnerLedgerAccountNumber: match.partnerAccountId ? state.accountLedger.get(match.partnerAccountId) : undefined,
    partnerTransactionId: match.partnerTransactionId,
  };
};

/** The two lines of one transfer side: Geldtransit against the account's own ledger account. */
export const transferLines = (draft: BookingDraftEntity, amount: number, bankAccount: string, transitAccount: string): BookingDraftEntity['lines'] => {
  const value = round(Math.abs(amount));
  const outgoing = amount < 0;
  return [
    { id: `${draft.id}-1`, accountNumber: outgoing ? transitAccount : bankAccount, debitAmount: value, creditAmount: 0 },
    { id: `${draft.id}-2`, accountNumber: outgoing ? bankAccount : transitAccount, debitAmount: 0, creditAmount: value },
  ];
};

export const createPostgresTransferRepository = (db: PostgresQueryable, helpers: TransferDraftHelpers): TransferRepository => {
  const audit = (client: PostgresQueryable, scope: TenantScope, entityId: string, action: string, mutation: AccountingMutationContext, before: unknown, after: unknown) => {
    const reason = mutation.reason?.trim();
    if (!reason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    return appendWithClient(client, scope, { occurredAt: now(), action, reason, actor: mutation.actor ?? { type: 'service', displayName: 'server-accounting' }, subject: { entityType: 'bank_transfer', entityId, tenantId: scope.tenantId }, change: { before, after } });
  };
  const bankRow = async (client: PostgresQueryable, scope: TenantScope, id: string) => {
    const row = (await q(client, `SELECT bt.*,a.default_skr_account_number FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id AND a.tenant_id=bt.tenant_id WHERE bt.tenant_id=$1 AND bt.id=$2 FOR UPDATE OF bt`, [scope.tenantId, id]))[0];
    if (!row) throw fail('BANK_TRANSACTION_NOT_FOUND', 404);
    return row;
  };
  const postedOnTransit = async (client: PostgresQueryable, scope: TenantScope, transactionId: string, transit: string): Promise<boolean | null> => {
    const rows = await q(client, `SELECT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.tenant_id=je.tenant_id AND jl.entry_id=je.id AND jl.account_number=$3) AS transit FROM journal_entries je JOIN booking_drafts bd ON bd.id=je.source_draft_id AND bd.tenant_id=je.tenant_id WHERE je.tenant_id=$1 AND bd.transaction_id=$2 AND je.status='posted'`, [scope.tenantId, transactionId, transit]);
    return rows[0] ? Boolean(rows[0].transit) : null;
  };

  return {
    async getBookingSettings(scope) { return loadBookingSettings(db, scope.tenantId); },

    async saveBookingSettings(scope, input) {
      return runInTransaction(db, async (tx) => {
        const before = await loadBookingSettings(tx, scope.tenantId);
        const next = { ...before, ...Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'mutation' && key !== 'updatedAt' && value !== undefined)) } as ProBookingSettings;
        if (!Number.isInteger(next.transferWindowDays) || next.transferWindowDays < 0 || next.transferWindowDays > 31) throw fail('TRANSFER_WINDOW_INVALID', 400);
        const stamp = now();
        await q(tx, `INSERT INTO pro_booking_settings (tenant_id,transfer_detection,transfer_window_days,auto_post_transfers,auto_post_rules,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (tenant_id) DO UPDATE SET transfer_detection=EXCLUDED.transfer_detection,transfer_window_days=EXCLUDED.transfer_window_days,auto_post_transfers=EXCLUDED.auto_post_transfers,auto_post_rules=EXCLUDED.auto_post_rules,updated_at=EXCLUDED.updated_at`,
          [scope.tenantId, next.transferDetection, next.transferWindowDays, next.autoPostTransfers, next.autoPostRules, stamp]);
        await audit(tx, scope, 'settings', 'update_settings', input.mutation, before, next);
        return { ...next, updatedAt: stamp };
      }, { serializable: true });
    },

    async confirmTransfer(scope, input) {
      return runInTransaction(db, async (tx) => {
        const roles = await helpers.roleAccounts(tx, scope);
        const transit = roles.transit!;
        const state = await loadTransferState(tx, scope, transit);
        const own = await bankRow(tx, scope, input.transactionId);
        // Without an explicit partner the current suggestion decides; it may have none (partner not imported yet).
        const suggested = state.matches.get(input.transactionId);
        const partnerId = input.partnerTransactionId ?? suggested?.partnerTransactionId;
        const partner = partnerId ? await bankRow(tx, scope, partnerId) : null;
        if (partner) {
          if (partner.account_id === own.account_id) throw fail('TRANSFER_SAME_ACCOUNT', 400);
          if (cents(partner.amount) !== -cents(own.amount)) throw fail('TRANSFER_AMOUNT_MISMATCH', 400);
          const taken = (await q(tx, `SELECT transaction_id FROM bank_transfer_links WHERE tenant_id=$1 AND status='confirmed' AND partner_transaction_id=$2 AND transaction_id<>$3`, [scope.tenantId, partner.id, own.id]))[0];
          if (taken) throw fail('TRANSFER_PARTNER_TAKEN');
        }
        const level: TransferLevel = suggested?.partnerTransactionId === partner?.id && suggested ? suggested.level : 'wahrscheinlich';
        const reasons = suggested?.partnerTransactionId === partner?.id && suggested ? suggested.reasons : partner ? ['von Hand zugeordnet'] : ['von Hand als Umbuchung markiert'];
        const drafts: BookingDraftEntity[] = [];
        for (const side of partner ? [own, partner] : [own]) {
          const posted = await postedOnTransit(tx, scope, side.id, transit);
          if (posted === false || (posted === null && side.status === 'booked')) throw fail('TRANSFER_SIDE_POSTED_ELSEWHERE');
          if (posted === null && side.status !== 'booked') {
            const draft = (await helpers.getDraft(tx, scope, side.id)) ?? (await helpers.createDraft(tx, scope, side.id));
            if (!draft) throw fail('BANK_TRANSACTION_NOT_FOUND', 404);
            const bankAccount = side.default_skr_account_number || roles.bank!;
            drafts.push(await helpers.saveDraft(tx, scope, {
              ...draft,
              workflowStatus: 'approved',
              bookingText: `Umbuchung: ${[side.counterparty, side.purpose].filter(Boolean).join(' – ')}`.slice(0, 200),
              lines: transferLines(draft, Number(side.amount), bankAccount, transit),
            }, input.mutation));
          }
          const partnerOfSide = side.id === own.id ? partner?.id ?? null : own.id;
          await q(tx, `INSERT INTO bank_transfer_links (tenant_id,transaction_id,partner_transaction_id,status,level,reasons_json,created_at,updated_at) VALUES ($1,$2,$3,'confirmed',$4,$5,$6,$6)
            ON CONFLICT (tenant_id,transaction_id) DO UPDATE SET partner_transaction_id=EXCLUDED.partner_transaction_id,status='confirmed',level=EXCLUDED.level,reasons_json=EXCLUDED.reasons_json,updated_at=EXCLUDED.updated_at`,
            [scope.tenantId, side.id, partnerOfSide, level, JSON.stringify(reasons), now()]);
        }
        await audit(tx, scope, own.id, 'confirm_transfer', input.mutation, null, { transactionId: own.id, partnerTransactionId: partner?.id ?? null, level });
        return drafts;
      }, { serializable: true });
    },

    async rejectTransfer(scope, input) {
      return runInTransaction(db, async (tx) => {
        const roles = await helpers.roleAccounts(tx, scope);
        const own = await bankRow(tx, scope, input.transactionId);
        // A posted Geldtransit side is corrected by Storno, never rewritten.
        if ((await postedOnTransit(tx, scope, own.id, roles.transit!)) === true) throw fail('TRANSFER_SIDE_POSTED_REVERSE_FIRST');
        const before = (await q(tx, `SELECT * FROM bank_transfer_links WHERE tenant_id=$1 AND transaction_id=$2`, [scope.tenantId, own.id]))[0] ?? null;
        // The partner of a confirmed pair loses its link too; it becomes a suggestion candidate again.
        await q(tx, `DELETE FROM bank_transfer_links WHERE tenant_id=$1 AND partner_transaction_id=$2 AND transaction_id<>$2`, [scope.tenantId, own.id]);
        await q(tx, `INSERT INTO bank_transfer_links (tenant_id,transaction_id,partner_transaction_id,status,level,reasons_json,created_at,updated_at) VALUES ($1,$2,NULL,'rejected',NULL,'[]',$3,$3)
          ON CONFLICT (tenant_id,transaction_id) DO UPDATE SET partner_transaction_id=NULL,status='rejected',level=NULL,reasons_json='[]',updated_at=EXCLUDED.updated_at`, [scope.tenantId, own.id, now()]);
        // An unposted draft still on Geldtransit is dropped so the next read proposes the normal booking.
        await q(tx, `DELETE FROM booking_drafts bd WHERE bd.tenant_id=$1 AND bd.transaction_id=$2 AND bd.workflow_status<>'posted' AND EXISTS (SELECT 1 FROM booking_draft_lines l WHERE l.tenant_id=bd.tenant_id AND l.draft_id=bd.id AND l.account_number=$3)`, [scope.tenantId, own.id, roles.transit]);
        await audit(tx, scope, own.id, 'reject_transfer', input.mutation, before, { status: 'rejected' });
      }, { serializable: true });
    },

    async getTransitOverview(scope) {
      const t = scope.tenantId;
      const roles = await helpers.roleAccounts(db, scope);
      const transit = roles.transit!;
      const monthRows = await q(db,
        `SELECT je.period, COALESCE(SUM(jl.debit_amount),0) AS debit, COALESCE(SUM(jl.credit_amount),0) AS credit
           FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
          WHERE jl.tenant_id=$1 AND jl.account_number=$2 AND je.status IN ('posted','reversed')
          GROUP BY je.period ORDER BY je.period`, [t, transit]);
      let cumulative = 0;
      const months = monthRows.map((row) => {
        const balance = round(Number(row.debit) - Number(row.credit));
        cumulative = round(cumulative + balance);
        return { period: row.period, debit: round(row.debit), credit: round(row.credit), balance, cumulative };
      });
      const settings = await loadBookingSettings(db, t);
      // Posted sides on Geldtransit whose partner is missing or not posted yet.
      const open = await q(db,
        `SELECT bt.id,bt.account_id,a.name AS account_name,COALESCE(a.default_skr_account_number,$3) AS ledger_account,bt.date,bt.amount,bt.counterparty,bt.purpose,
                je.entry_number,je.posting_date,l.partner_transaction_id,p.account_id AS partner_account_id,pa.name AS partner_account_name
           FROM bank_transactions bt
           JOIN accounts a ON a.id=bt.account_id AND a.tenant_id=bt.tenant_id
           JOIN booking_drafts bd ON bd.transaction_id=bt.id AND bd.tenant_id=bt.tenant_id
           JOIN journal_entries je ON je.source_draft_id=bd.id AND je.tenant_id=bd.tenant_id AND je.status='posted'
           LEFT JOIN bank_transfer_links l ON l.tenant_id=bt.tenant_id AND l.transaction_id=bt.id AND l.status='confirmed'
           LEFT JOIN bank_transactions p ON p.tenant_id=bt.tenant_id AND p.id=l.partner_transaction_id
           LEFT JOIN accounts pa ON pa.tenant_id=p.tenant_id AND pa.id=p.account_id
          WHERE bt.tenant_id=$1
            AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.tenant_id=je.tenant_id AND jl.entry_id=je.id AND jl.account_number=$2)
            AND (p.id IS NULL OR NOT EXISTS (
              SELECT 1 FROM booking_drafts pd JOIN journal_entries pe ON pe.source_draft_id=pd.id AND pe.tenant_id=pd.tenant_id AND pe.status='posted'
               WHERE pd.tenant_id=p.tenant_id AND pd.transaction_id=p.id))
          ORDER BY bt.date DESC, bt.id`, [t, transit, roles.bank]);
      const state = await loadTransferState(db, scope, transit);
      const pool = await q(db,
        `SELECT bt.id,bt.account_id,a.name AS account_name,bt.date,bt.amount,bt.counterparty,bt.purpose FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id AND a.tenant_id=bt.tenant_id
          WHERE bt.tenant_id=$1 AND bt.linked_invoice_id IS NULL AND NOT EXISTS (SELECT 1 FROM bank_transfer_links l WHERE l.tenant_id=bt.tenant_id AND (l.transaction_id=bt.id OR l.partner_transaction_id=bt.id))`, [t]);
      const openSides: TransitOpenSide[] = open.map((row) => {
        const suggested = state.matches.get(row.id);
        const partnerAccountId = row.partner_account_id ?? suggested?.partnerAccountId;
        const candidates = pool
          .filter((c) => c.account_id !== row.account_id && cents(c.amount) === -cents(row.amount) && Math.abs(dayDiff(row.date, c.date)) <= OPEN_SIDE_SEARCH_DAYS && (!partnerAccountId || c.account_id === partnerAccountId))
          .map((c) => ({ transactionId: c.id, accountId: c.account_id, accountName: c.account_name, date: c.date, amount: Number(c.amount), counterparty: c.counterparty ?? '', purpose: c.purpose ?? '', days: dayDiff(row.date, c.date), outsideWindow: Math.abs(dayDiff(row.date, c.date)) > settings.transferWindowDays }))
          .sort((x, y) => Math.abs(x.days) - Math.abs(y.days));
        return {
          transactionId: row.id, accountId: row.account_id, accountName: row.account_name, ledgerAccountNumber: row.ledger_account,
          date: row.date, amount: Number(row.amount), counterparty: row.counterparty ?? '', purpose: row.purpose ?? '',
          entryNumber: Number(row.entry_number), postingDate: row.posting_date,
          partnerAccountId, partnerAccountName: row.partner_account_name ?? (partnerAccountId ? state.accountNames.get(partnerAccountId) : undefined),
          partnerTransactionId: row.partner_transaction_id ?? undefined, candidates,
        };
      });
      return { transitAccountNumber: transit, months, openBalance: months.at(-1)?.cumulative ?? 0, openSides };
    },
  };
};

