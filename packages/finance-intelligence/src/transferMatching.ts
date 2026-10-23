import { normalizeGermanText } from './text';

/**
 * Transfers between the tenant's own financial accounts (Giro ↔ Kreditkarte,
 * PayPal, Tagesgeld). Pure: callers load bank lines, accounts and stored
 * decisions and get one match per bank line back.
 *
 * - "sicher": the counterparty IBAN (or an IBAN in the text) is another own account.
 * - "wahrscheinlich": another own account has the opposite amount within the window.
 * Keywords only add a reason; they never create a match on their own, because a
 * card purchase via "PayPal" from the Giro is not a transfer.
 */

export type TransferLevel = 'sicher' | 'wahrscheinlich';

export interface TransferAccount {
  id: string;
  name: string;
  iban?: string | null;
}

export interface TransferTransaction {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  counterparty: string;
  purpose: string;
  counterpartyIban?: string | null;
}

/** A stored decision; suggestions themselves are never stored. */
export interface TransferDecision {
  transactionId: string;
  status: 'confirmed' | 'rejected';
  partnerTransactionId?: string | null;
  level?: TransferLevel | null;
  reasons?: string[];
}

export interface TransferMatch {
  transactionId: string;
  /** Own account on the other side; unknown only for a confirmed side whose partner is missing. */
  partnerAccountId?: string;
  partnerTransactionId?: string;
  level: TransferLevel;
  reasons: string[];
  status: 'suggested' | 'confirmed';
}

export const DEFAULT_TRANSFER_WINDOW_DAYS = 7;

const KEYWORDS = ['umbuchung', 'uebertrag', 'kreditkarte', 'kartenabrechnung', 'abrechnung', 'aufladung', 'auszahlung', 'bankgutschrift', 'guthaben', 'zahlung erhalten', 'ausgleich', 'tagesgeld'];

export const normalizeIban = (value: string | null | undefined): string => (value ?? '').replace(/[\s-]/g, '').toUpperCase();

const cents = (amount: number) => Math.round(Number(amount) * 100);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
const dayText = (days: number) => (days === 0 ? 'am selben Tag' : days > 0 ? `${days} ${days === 1 ? 'Tag' : 'Tage'} später` : `${-days} ${days === -1 ? 'Tag' : 'Tage'} früher`);

/** The own account (other than the line's own) that the line names by IBAN. */
const ownAccountNamed = (tx: TransferTransaction, byIban: Map<string, TransferAccount>): TransferAccount | undefined => {
  const direct = byIban.get(normalizeIban(tx.counterpartyIban));
  if (direct && direct.id !== tx.accountId) return direct;
  const text = normalizeIban(`${tx.counterparty} ${tx.purpose}`);
  for (const [iban, account] of byIban) if (account.id !== tx.accountId && text.includes(iban)) return account;
  return undefined;
};

const keywordReason = (tx: TransferTransaction): string | undefined => {
  const text = normalizeGermanText(`${tx.counterparty} ${tx.purpose}`);
  const hit = KEYWORDS.find((keyword) => text.includes(keyword));
  return hit ? `Stichwort „${hit}“` : undefined;
};

export const matchTransfers = (
  transactions: readonly TransferTransaction[],
  accounts: readonly TransferAccount[],
  options: { windowDays?: number; decisions?: readonly TransferDecision[] } = {},
): Map<string, TransferMatch> => {
  const windowDays = options.windowDays ?? DEFAULT_TRANSFER_WINDOW_DAYS;
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const byIban = new Map<string, TransferAccount>();
  for (const account of accounts) {
    const iban = normalizeIban(account.iban);
    // Short placeholders ("DE00", an e-mail) would match too much text.
    if (iban.length >= 15) byIban.set(iban, account);
  }
  const txById = new Map(transactions.map((tx) => [tx.id, tx]));
  const out = new Map<string, TransferMatch>();
  const taken = new Set<string>();

  for (const decision of options.decisions ?? []) {
    taken.add(decision.transactionId);
    if (decision.status !== 'confirmed') continue;
    const partner = decision.partnerTransactionId ? txById.get(decision.partnerTransactionId) : undefined;
    const own = txById.get(decision.transactionId);
    out.set(decision.transactionId, {
      transactionId: decision.transactionId,
      partnerAccountId: partner?.accountId ?? (own ? ownAccountNamed(own, byIban)?.id : undefined),
      partnerTransactionId: partner?.id,
      level: decision.level ?? 'wahrscheinlich',
      reasons: decision.reasons ?? [],
      status: 'confirmed',
    });
  }
  // A line already confirmed as someone's partner is not free either.
  for (const match of out.values()) if (match.partnerTransactionId) taken.add(match.partnerTransactionId);

  const free = transactions.filter((tx) => !taken.has(tx.id) && accountById.has(tx.accountId) && cents(tx.amount) !== 0);
  const named = new Map(free.map((tx) => [tx.id, ownAccountNamed(tx, byIban)]));
  type Edge = { a: TransferTransaction; b: TransferTransaction; days: number; sure: boolean };
  const edges: Edge[] = [];
  const byAmount = new Map<number, TransferTransaction[]>();
  for (const tx of free) byAmount.set(cents(tx.amount), [...(byAmount.get(cents(tx.amount)) ?? []), tx]);
  for (const a of free) {
    for (const b of byAmount.get(-cents(a.amount)) ?? []) {
      if (b.accountId === a.accountId || a.id > b.id) continue;
      const days = dayDiff(a.date, b.date);
      if (Math.abs(days) > windowDays) continue;
      const namedA = named.get(a.id); const namedB = named.get(b.id);
      // An IBAN that names a third account contradicts this pairing.
      if ((namedA && namedA.id !== b.accountId) || (namedB && namedB.id !== a.accountId)) continue;
      edges.push({ a, b, days, sure: Boolean(namedA || namedB) });
    }
  }
  const score = (edge: Edge) => (edge.sure ? 1000 : 0) - Math.abs(edge.days);
  edges.sort((x, y) => score(y) - score(x) || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));
  const bestScore = new Map<string, { score: number; count: number }>();
  for (const edge of edges) {
    for (const tx of [edge.a, edge.b]) {
      const current = bestScore.get(tx.id);
      if (!current) bestScore.set(tx.id, { score: score(edge), count: 1 });
      else if (current.score === score(edge)) current.count += 1;
    }
  }

  const reasonsFor = (self: TransferTransaction, partner: TransferTransaction, days: number, ambiguous: boolean): string[] => {
    const reasons: string[] = [];
    const namedSelf = named.get(self.id); const namedPartner = named.get(partner.id);
    if (namedSelf) reasons.push(`Gegen-IBAN ist Ihr Konto „${namedSelf.name}“`);
    else if (namedPartner) reasons.push(`Gegenseite nennt Ihr Konto „${accountById.get(self.accountId)?.name ?? self.accountId}“`);
    reasons.push('Gegenbetrag', dayText(days));
    const keyword = keywordReason(self) ?? keywordReason(partner);
    if (keyword) reasons.push(keyword);
    if (ambiguous) reasons.push('mehrere Kandidaten');
    return reasons;
  };

  for (const edge of edges) {
    if (out.has(edge.a.id) || out.has(edge.b.id)) continue;
    const ambiguous = [edge.a, edge.b].some((tx) => (bestScore.get(tx.id)?.count ?? 0) > 1);
    const level: TransferLevel = edge.sure && !ambiguous ? 'sicher' : 'wahrscheinlich';
    out.set(edge.a.id, { transactionId: edge.a.id, partnerAccountId: edge.b.accountId, partnerTransactionId: edge.b.id, level, reasons: reasonsFor(edge.a, edge.b, edge.days, ambiguous), status: 'suggested' });
    out.set(edge.b.id, { transactionId: edge.b.id, partnerAccountId: edge.a.accountId, partnerTransactionId: edge.a.id, level, reasons: reasonsFor(edge.b, edge.a, -edge.days, ambiguous), status: 'suggested' });
  }

  // Named by IBAN but the other side is not imported (yet): still a transfer, partner missing.
  for (const tx of free) {
    const account = named.get(tx.id);
    if (!account || out.has(tx.id)) continue;
    const keyword = keywordReason(tx);
    out.set(tx.id, { transactionId: tx.id, partnerAccountId: account.id, level: 'sicher', reasons: [`Gegen-IBAN ist Ihr Konto „${account.name}“`, ...(keyword ? [keyword] : []), 'Gegenseite fehlt'], status: 'suggested' });
  }
  return out;
};
