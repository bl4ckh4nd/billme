import { localIsoDate, type DunningHistoryEntry, type DunningLevel } from './dunning.js';
import type { Invoice } from './foundations.js';

export type DunningDocumentContext = {
  level: number;
  levelName: string;
  date: string;
  payUntil: string;
  fee: number;
  originalAmount: number;
  paidAmount: number;
  /** Issued credit notes for the invoice; they reduce what is open like payments do. */
  creditedAmount: number;
  daysOverdue: number;
  /** Intro of the letter: the level's reminder text with placeholders. */
  intro?: string;
};

// ponytail: a fixed 7-day payment period after the reminder; replace once the dunning levels carry their own period.
const PAY_WITHIN_DAYS = 7;

const DAY_MS = 86_400_000;
const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * What a dunning letter for `level` shows: the invoice amount, what was paid and
 * credited, and the fees. Fees live only in the dunning history, never in the
 * invoice amount. The letter's fee is what was charged up to its level, plus the
 * level's own fee when that level has not run yet (a preview).
 */
export const buildDunningDocumentContext = (input: {
  invoice: Pick<Invoice, 'number' | 'date' | 'dueDate' | 'amount' | 'payments' | 'dunningLevel'>;
  level?: number;
  levels: DunningLevel[];
  history: DunningHistoryEntry[];
  credited?: number;
  today: Date;
}): DunningDocumentContext => {
  const level = input.level ?? Math.max(1, input.invoice.dunningLevel ?? 0);
  const definition = input.levels.find((candidate) => candidate.id === level);
  const sumFees = (entries: DunningHistoryEntry[]) => entries.reduce((sum, entry) => sum + entry.feeApplied, 0);
  const atLevel = input.history.filter((entry) => entry.dunningLevel === level).at(-1);
  const fee = sumFees(input.history.filter((entry) => entry.dunningLevel <= level)) + (atLevel ? 0 : definition?.fee ?? 0);
  // Letter day, payment period and days overdue are calendar days where the business is (see localIsoDate).
  const letterDay = localIsoDate(atLevel ? new Date(atLevel.processedAt) : input.today);
  const payUntil = new Date(dayMs(letterDay) + PAY_WITHIN_DAYS * DAY_MS).toISOString().slice(0, 10);
  const daysOverdue = Math.max(0, Math.round((dayMs(letterDay) - dayMs(input.invoice.dueDate)) / DAY_MS));
  const text = definition?.text.trim();
  return {
    level,
    levelName: definition?.name ?? `${level}. Mahnung`,
    date: letterDay,
    payUntil,
    fee: round2(fee),
    originalAmount: round2(input.invoice.amount),
    paidAmount: round2((input.invoice.payments ?? []).reduce((sum, payment) => sum + payment.amount, 0)),
    creditedAmount: round2(input.credited ?? 0),
    daysOverdue,
    intro: text
      ? `Sehr geehrte Damen und Herren,\n\n${text.replaceAll('%N', '{{invoice.number}}').replaceAll('%D', '{{invoice.date}}')}\n\nBitte überweisen Sie den offenen Betrag bis zum {{dunning.payUntil}}.`
      : undefined,
  };
};
