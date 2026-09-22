/**
 * Server runtimes rebuild a document's timeline from the audit log as
 * "<entity>.<action> (<reason>)". This turns those codes into German timeline
 * text; free-text reasons typed by the user stay as they are, and legacy
 * entries that are already prose pass through unchanged.
 */

const ACTION_LABELS: Record<string, string> = {
  create: 'Erstellt',
  created: 'Erstellt',
  update: 'Geändert',
  delete: 'Gelöscht',
  'chain.create': 'Folgebeleg erstellt',
  pdf: 'PDF erzeugt',
  publish: 'Im Kundenportal veröffentlicht',
  portal_token_reserved: 'Portal-Link vorbereitet',
  portal_decision: 'Entscheidung im Kundenportal',
  dunning_reminder_sent: 'Mahnung per E-Mail versendet',
  dunning_reminder_failed: 'Mahnung konnte nicht versendet werden',
};

/** Reason codes that describe the whole event and replace the action label. */
const EVENT_REASONS: Record<string, string> = {
  email_sent: 'Per E-Mail versendet',
  invoice_finalize: 'Festgeschrieben',
  dunning_create: 'Mahnstufe gesetzt',
  bad_debt: 'Als Forderungsausfall gebucht',
  'Tax filing submitted through Billme': 'Steuermeldung übermittelt',
};

/** Reason codes that add nothing beyond the action label. */
const SILENT_REASONS = new Set(['create', 'Reserve bearer token before portal publication']);

const REASON_LABELS: Record<string, string> = {
  manual: 'manuell',
  'retention-policy': 'Aufbewahrungsregel',
};

const REASON_PATTERNS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/^Converted from offer (.+)$/, (m) => `aus Angebot ${m[1]} übernommen`],
];

const ENTRY_PATTERN = /^(?:invoice|offer)\.([a-z_.]+)(?: \(([\s\S]*)\))?$/;

export const formatDocumentHistoryAction = (entry: string): string => {
  const match = ENTRY_PATTERN.exec(entry);
  const actionLabel = match ? ACTION_LABELS[match[1] ?? ''] : undefined;
  if (!match || !actionLabel) return entry;

  const reason = match[2]?.trim();
  if (!reason || SILENT_REASONS.has(reason)) return actionLabel;
  if (reason.startsWith('Notiz: ')) return reason;
  const event = EVENT_REASONS[reason];
  if (event) return event;

  const pattern = REASON_PATTERNS.find(([regex]) => regex.test(reason));
  const reasonText = pattern ? pattern[1](pattern[0].exec(reason)!) : REASON_LABELS[reason] ?? reason;
  return `${actionLabel} · ${reasonText}`;
};
