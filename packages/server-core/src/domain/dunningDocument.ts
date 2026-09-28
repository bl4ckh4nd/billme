import type { DunningHistoryEntry, DunningLevel } from './dunning.js';
import type { Invoice } from './foundations.js';

export type DunningDocumentContext = {
  level: number;
  levelName: string;
  date: string;
  payUntil: string;
  fee: number;
  originalAmount: number;
  paidAmount: number;
  daysOverdue: number;
  /** Intro of the letter: the level's reminder text with placeholders. */
  intro?: string;
};

// ponytail: a fixed 7-day payment period after the reminder; replace once the dunning levels carry their own period.
const PAY_WITHIN_DAYS = 7;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * What a dunning letter for `level` shows. The dunning run adds each fee to
 * the invoice amount, so the original amount is the current amount minus every
 * fee in the history. The letter's fee is what was charged up to its level,
 * plus the level's own fee when that level has not run yet (a preview).
 */
export const buildDunningDocumentContext = (input: {
  invoice: Pick<Invoice, 'number' | 'date' | 'dueDate' | 'amount' | 'payments' | 'dunningLevel'>;
  level?: number;
  levels: DunningLevel[];
  history: DunningHistoryEntry[];
  today: Date;
}): DunningDocumentContext => {
  const level = input.level ?? Math.max(1, input.invoice.dunningLevel ?? 0);
  const definition = input.levels.find((candidate) => candidate.id === level);
  const sumFees = (entries: DunningHistoryEntry[]) => entries.reduce((sum, entry) => sum + entry.feeApplied, 0);
  const atLevel = input.history.filter((entry) => entry.dunningLevel === level).at(-1);
  const fee = sumFees(input.history.filter((entry) => entry.dunningLevel <= level)) + (atLevel ? 0 : definition?.fee ?? 0);
  const letterDate = atLevel ? new Date(atLevel.processedAt) : input.today;
  const payUntil = new Date(letterDate);
  payUntil.setUTCDate(payUntil.getUTCDate() + PAY_WITHIN_DAYS);
  const due = new Date(`${input.invoice.dueDate}T00:00:00Z`);
  const daysOverdue = Math.max(0, Math.floor((Date.UTC(letterDate.getUTCFullYear(), letterDate.getUTCMonth(), letterDate.getUTCDate()) - due.getTime()) / 86_400_000));
  const text = definition?.text.trim();
  return {
    level,
    levelName: definition?.name ?? `${level}. Mahnung`,
    date: isoDay(letterDate),
    payUntil: isoDay(payUntil),
    fee: round2(fee),
    originalAmount: round2(input.invoice.amount - sumFees(input.history)),
    paidAmount: round2((input.invoice.payments ?? []).reduce((sum, payment) => sum + payment.amount, 0)),
    daysOverdue,
    intro: text
      ? `Sehr geehrte Damen und Herren,\n\n${text.replaceAll('%N', '{{invoice.number}}').replaceAll('%D', '{{invoice.date}}')}\n\nBitte überweisen Sie den offenen Betrag bis zum {{dunning.payUntil}}.`
      : undefined,
  };
};
