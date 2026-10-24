import type { AppSettings, Invoice, Offer } from '@billme/desktop-core/types';
import { localIsoDate } from '@billme/desktop-utils/formatters';
import { calculateInvoiceTaxSnapshot } from '@billme/server-core/services';

const DAY_MS = 86_400_000;
const isoDay = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
// Calendar arithmetic on YYYY-MM-DD anchored at UTC midnight: no local time is converted.
const addDays = (date: string, days: number) => new Date(isoDay(date) + days * DAY_MS).toISOString().slice(0, 10);

/** Only plain invoices and offers can be copied; corrections and chain documents follow their source. */
export const canDuplicateDocument = (kind: 'invoice' | 'offer', document: Pick<Invoice, 'documentKind'>): boolean =>
  kind === 'offer' || (document.documentKind ?? 'invoice') === 'invoice';

/**
 * A new draft with the source's client, positions, tax mode and texts under a
 * freshly reserved number. Everything that belongs to the issued source stays
 * behind: payments, history, the frozen layout snapshot, portal sharing and
 * decisions, chain/revision links and the dunning level.
 */
export const duplicateDocument = <T extends Invoice | Offer>(
  source: T,
  options: {
    kind: 'invoice' | 'offer';
    id: string;
    reservation: { number: string; reservationId: string };
    settings: AppSettings;
    today?: string;
  },
): T => {
  const {
    payments: _payments, history: _history, layout, taxSnapshot: _taxSnapshot,
    shareToken: _shareToken, sharePublishedAt: _sharePublishedAt, shareDecision: _shareDecision, shareDecisionTextVersion: _shareDecisionTextVersion,
    acceptedAt: _acceptedAt, acceptedBy: _acceptedBy, acceptedEmail: _acceptedEmail, acceptedUserAgent: _acceptedUserAgent,
    sourceDocumentId: _sourceDocumentId, rootDocumentId: _rootDocumentId, revisionOfId: _revisionOfId, revisionNumber: _revisionNumber,
    dunningLevel: _dunningLevel,
    ...kept
  } = structuredClone(source);
  const today = options.today ?? localIsoDate();
  // Offers keep their validity span; invoices get the configured payment term.
  const dueOffset = options.kind === 'offer'
    ? (source.dueDate ? Math.max(0, Math.round((isoDay(source.dueDate) - isoDay(source.date)) / DAY_MS)) : 0)
    : options.settings.legal.paymentTermsDays;
  const { snapshot: _snapshot, ...layoutChoice } = layout ?? {};
  const taxSnapshot = calculateInvoiceTaxSnapshot({ items: kept.items, taxMode: kept.taxMode, taxMeta: kept.taxMeta }, options.settings);
  return {
    ...kept,
    id: options.id,
    number: options.reservation.number,
    numberReservationId: options.reservation.reservationId,
    status: 'draft',
    date: today,
    dueDate: addDays(today, dueOffset),
    payments: [],
    history: [],
    taxSnapshot,
    amount: taxSnapshot.grossAmount,
    ...(Object.keys(layoutChoice).length > 0 ? { layout: layoutChoice } : {}),
  } as unknown as T;
};
