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
  /** Verzugszinsen claimed in this letter, with the yearly rate and the days counted. */
  interest?: number;
  interestRatePercent?: number;
  interestDays?: number;
  /** The fee is the §288 Abs. 5 BGB Pauschale (fees charged before are credited against it). */
  flatFee?: boolean;
  /** Intro of the letter: the level's reminder text with placeholders. */
  intro?: string;
};

// ponytail: a fixed 7-day payment period after the reminder; replace once the dunning levels carry their own period.
const PAY_WITHIN_DAYS = 7;

const DAY_MS = 86_400_000;
const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const round2 = (value: number) => Math.round(value * 100) / 100;

export const FLAT_FEE_288 = 40;

/** Only a customer known to be a business owes the Pauschale and the higher rate; unknown counts as a consumer. */
export const isBusinessBuyer = (invoice: Pick<Invoice, 'taxMeta'>): boolean =>
  invoice.taxMeta?.buyerType === 'business' || Boolean(invoice.taxMeta?.buyerVatId?.trim());

/**
 * What a level charges on top of the claim. With the Pauschale on and a business customer it is the
 * 40 € minus the fees already charged, which are credited against it (§288 Abs. 5 S. 3 BGB).
 */
export const dunningLevelFee = (level: Pick<DunningLevel, 'fee' | 'chargeFlatFee'>, invoice: Pick<Invoice, 'taxMeta'>, feesBefore: number): number =>
  level.chargeFlatFee && isBusinessBuyer(invoice) ? Math.max(0, round2(FLAT_FEE_288 - feesBefore)) : level.fee;

/**
 * Verzugszinsen on the open amount: base rate + 9 points for a business, + 5 otherwise (§288 Abs. 1/2 BGB).
 * A business is in default from the day after the calendar due date (§286 Abs. 2 Nr. 1); a consumer
 * from the first reminder, since an invoice's own due date does not put a consumer in default.
 */
export const lateInterest = (input: { open: number; dueDate: string; letterDay: string; business: boolean; baseRatePercent: number; firstReminderDay?: string }) => {
  const ratePercent = round2(input.baseRatePercent + (input.business ? 9 : 5));
  const from = input.business ? input.dueDate.slice(0, 10) : input.firstReminderDay;
  const days = from ? Math.max(0, Math.round((dayMs(input.letterDay) - dayMs(from)) / DAY_MS)) : 0;
  return { ratePercent, days, amount: input.open > 0 && ratePercent > 0 ? round2(input.open * ratePercent / 100 * days / 365) : 0 };
};

/**
 * What a dunning letter for `level` shows: the invoice amount, what was paid and
 * credited, and the fees. Fees live only in the dunning history, never in the
 * invoice amount. The letter's fee is what was charged up to its level, plus the
 * level's own fee when that level has not run yet (a preview).
 */
export const buildDunningDocumentContext = (input: {
  invoice: Pick<Invoice, 'number' | 'date' | 'dueDate' | 'amount' | 'payments' | 'dunningLevel' | 'taxMeta'>;
  level?: number;
  levels: DunningLevel[];
  history: DunningHistoryEntry[];
  credited?: number;
  /** Basiszinssatz in percent; the user keeps it current (it changes on 1 January and 1 July). */
  baseInterestRatePercent?: number;
  today: Date;
}): DunningDocumentContext => {
  const level = input.level ?? Math.max(1, input.invoice.dunningLevel ?? 0);
  const definition = input.levels.find((candidate) => candidate.id === level);
  const sumFees = (entries: DunningHistoryEntry[]) => entries.reduce((sum, entry) => sum + entry.feeApplied, 0);
  const atLevel = input.history.filter((entry) => entry.dunningLevel === level).at(-1);
  const charged = sumFees(input.history.filter((entry) => entry.dunningLevel <= level));
  const fee = charged + (atLevel || !definition ? 0 : dunningLevelFee(definition, input.invoice, charged));
  const business = isBusinessBuyer(input.invoice);
  // Letter day, payment period and days overdue are calendar days where the business is (see localIsoDate).
  const letterDay = localIsoDate(atLevel ? new Date(atLevel.processedAt) : input.today);
  const payUntil = new Date(dayMs(letterDay) + PAY_WITHIN_DAYS * DAY_MS).toISOString().slice(0, 10);
  const daysOverdue = Math.max(0, Math.round((dayMs(letterDay) - dayMs(input.invoice.dueDate)) / DAY_MS));
  const text = definition?.text.trim();
  const paidAmount = round2((input.invoice.payments ?? []).reduce((sum, payment) => sum + payment.amount, 0));
  const open = round2(input.invoice.amount - paidAmount - (input.credited ?? 0));
  const firstReminder = input.history.filter((entry) => entry.emailSent && entry.dunningLevel < level).map((entry) => localIsoDate(new Date(entry.processedAt))).sort()[0];
  const interest = definition?.chargeInterest && input.baseInterestRatePercent !== undefined
    ? lateInterest({ open, dueDate: input.invoice.dueDate, letterDay, business, baseRatePercent: input.baseInterestRatePercent, firstReminderDay: firstReminder })
    : undefined;
  return {
    level,
    levelName: definition?.name ?? `${level}. Mahnung`,
    date: letterDay,
    payUntil,
    fee: round2(fee),
    originalAmount: round2(input.invoice.amount),
    paidAmount,
    creditedAmount: round2(input.credited ?? 0),
    daysOverdue,
    ...(interest ? { interest: interest.amount, interestRatePercent: interest.ratePercent, interestDays: interest.days } : {}),
    ...(definition?.chargeFlatFee && business ? { flatFee: true } : {}),
    intro: text
      ? `Sehr geehrte Damen und Herren,\n\n${text.replaceAll('%N', '{{invoice.number}}').replaceAll('%D', '{{invoice.date}}')}\n\nBitte überweisen Sie den offenen Betrag bis zum {{dunning.payUntil}}.`
      : undefined,
  };
};
