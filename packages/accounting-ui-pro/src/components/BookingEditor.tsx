import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Lock,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { defaultBookingPolicy } from '../domain/policies';
import { WORKFLOW_STEPS, getWorkflowStep } from '../domain/selectors';
import { findTaxCaseOption, normalizeTaxCaseKey, TAX_CASE_OPTIONS, toLegacyTaxCode } from '../domain/taxCases';
import { hasBlockingIssues, validateBookingDraft } from '../domain/validation';
import { getAllowedActions } from '../domain/workflow';
import { permissionContextForRole } from '../domain/permissions';
import { useAccountingWorkspace, useWorkspaceLifetime } from '../AccountingWorkspaceContext';
import { Badge, Button, ConfirmDialog, IconButton, Input, Modal, Select, Stepper } from '@billme/ui';
import { accountingErrorText } from '@billme/accounting-shared';
import { BOOKING_TEMPLATES, PRIVATE_ACCOUNTS } from '../domain/bookingTemplates';
import { Account, BookingAction, BookingDraft, JournalLine, Transaction, UserRole } from '../types';
import AccountCombobox from './AccountCombobox';
import ActivityTimeline from './ActivityTimeline';
import { StatusBadge } from './IssueBadges';
import ValidationSummary from './ValidationSummary';
import WorkflowActionBar from './WorkflowActionBar';
import type { BankTransactionDocument, ProAccountingDataAdapter } from '../services/accountingDataAdapter';

type BankReceiptApi = Pick<ProAccountingDataAdapter, 'listBankTransactionDocuments' | 'uploadBankTransactionDocument' | 'downloadBankTransactionDocument'>;
const RECEIPT_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};

/** Belege on the bank line: archived unchanged on the server; the posting names them. */
function BankReceiptSection({ transactionId, hasReceipt, canAttach, api, onAttached }: { transactionId: string; hasReceipt: boolean; canAttach: boolean; api?: BankReceiptApi; onAttached: () => void }) {
  const [documents, setDocuments] = useState<BankTransactionDocument[]>([]);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const list = api?.listBankTransactionDocuments;
  useEffect(() => {
    if (!list) return;
    let cancelled = false;
    void list(transactionId).then((rows) => { if (!cancelled) setDocuments(rows); }).catch(() => { if (!cancelled) setDocuments([]); });
    return () => { cancelled = true; };
  }, [list, transactionId]);
  const attach = async (file: File | undefined) => {
    if (!file || !api?.uploadBankTransactionDocument) return;
    if (inputRef.current) inputRef.current.value = '';
    if (!RECEIPT_MIME_TYPES.has(file.type)) { setMessage({ kind: 'error', text: 'Nur PDF-, JPEG-, PNG- und WebP-Dateien werden archiviert.' }); return; }
    if (file.size <= 0 || file.size > RECEIPT_MAX_BYTES) { setMessage({ kind: 'error', text: 'Belege dürfen höchstens 10 MiB groß sein.' }); return; }
    setUploading(true);
    setMessage(null);
    try {
      const saved = await api.uploadBankTransactionDocument({ transactionId, originalFilename: file.name, mimeType: file.type as BankTransactionDocument['mimeType'], data: toBase64(new Uint8Array(await file.arrayBuffer())), reason: `Beleg an Bankzeile angehängt: ${file.name}` });
      setDocuments((current) => current.some((doc) => doc.id === saved.id) ? current : [...current, saved]);
      setMessage({ kind: 'success', text: 'Beleg archiviert. Die Buchung verweist beim Buchen auf ihn.' });
      onAttached();
    } catch (error) {
      setMessage({ kind: 'error', text: accountingErrorText(error instanceof Error ? error.message : String(error)) });
    } finally {
      setUploading(false);
    }
  };
  const download = async (doc: BankTransactionDocument) => {
    if (!api?.downloadBankTransactionDocument) return;
    const result = await api.downloadBankTransactionDocument(doc.id);
    const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: doc.mimeType }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = doc.originalFilename;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section aria-label="Beleg">
      <h3 className="mb-2 text-eyebrow uppercase text-muted">Beleg</h3>
      {hasReceipt || documents.length ? (
        <div className="flex items-center gap-2 text-caption text-foreground-secondary">
          <Check size={14} aria-hidden="true" className="shrink-0 text-success-text" />
          Beleg vorhanden
        </div>
      ) : (
        <div className="rounded-control border border-dashed border-border-strong px-2.5 py-5 text-center text-sm font-semibold text-foreground">
          Beleg fehlt
        </div>
      )}
      {documents.length ? (
        <ul className="mt-2 flex flex-col gap-1" aria-label="Archivierte Belege">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button type="button" className="truncate text-left text-caption text-accent underline-offset-2 hover:underline" onClick={() => void download(doc)}>{doc.originalFilename}</button>
            </li>
          ))}
        </ul>
      ) : null}
      {canAttach && api?.uploadBankTransactionDocument ? (
        <div className="mt-2">
          <input ref={inputRef} id={`receipt-${transactionId}`} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => void attach(event.target.files?.[0])} />
          <Button variant="secondary" size="sm" disabled={uploading} onClick={() => inputRef.current?.click()}>{uploading ? 'Wird archiviert…' : 'Beleg anhängen'}</Button>
        </div>
      ) : null}
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} data-testid="receipt-message" className={message.kind === 'error' ? 'mt-2 text-caption text-danger-text' : 'mt-2 text-caption text-success-text'}>{message.text}</p> : null}
    </section>
  );
}

interface BookingEditorProps {
  transactionId: string | null;
  role: UserRole;
  accounts?: Account[];
  /** GmbH/UG: no Privat templates. */
  corporation?: boolean;
  onBack: () => void;
  /** Reports whether the draft differs from the stored one, so the workbench can guard a switch. */
  onDirtyChange?: (dirty: boolean) => void;
  onStoreChange: () => void;
  /** Belege on the bank line; without it the section only shows the state. */
  receiptApi?: BankReceiptApi;
}

function formatCurrency(amount: number | string, currency: string) {
  const num = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  const safe = Number.isFinite(num) ? num : 0;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(safe);
}

function parseAmountInput(value: string) {
  return value.replace(',', '.');
}

const LIVE_CHECKED_CODES = new Set(['MISSING_POSTING_DATE', 'MISSING_BOOKING_TEXT', 'MISSING_ACCOUNT', 'INVALID_AMOUNT_FORMAT', 'UNBALANCED_ENTRY']);

// The prototype's .lines table: S|H 82px, account and tax case share the rest, amount 104px, delete 32px.
const LINE_GRID = 'grid grid-cols-[82px_minmax(0,1.1fr)_minmax(0,1fr)_104px_32px] gap-x-2';
const LINE_INDENT = 'pl-22.5';

const ACTION_DONE: Partial<Record<BookingAction, string>> = {
  submit_for_review: 'Zur Prüfung gegeben. Die Buchung steht jetzt in der Liste „Zur Prüfung“.',
  approve: 'Freigegeben. Als Nächstes: Buchen.',
  reject: 'Zur Korrektur zurückgegeben.',
  post: 'Gebucht. Die Buchung steht im Journal.',
  reverse: 'Storniert. Die Gegenbuchung steht im Journal.',
  create_correction: 'Wieder offen: neu kontieren, prüfen und buchen. Original und Storno bleiben im Journal.',
  request_receipt: 'Beleg angefordert. Die Buchung bleibt bis zum Beleg in „Ohne Beleg“.',
};

function actionRequiresConfirmation(action: BookingAction) {
  return action === 'reverse' || action === 'reject';
}

export default function BookingEditor({ transactionId, role, accounts, corporation = false, onBack, onStoreChange, onDirtyChange, receiptApi }: BookingEditorProps) {
  const editorId = useId();
  const store = useAccountingWorkspace();
  const captureLifetime = useWorkspaceLifetime(transactionId);
  const { dispatchBookingAction, getBookingDraftByTransactionId, getTransactionById, saveDraft } = store;
  const accountOptions = accounts ?? store.listAccounts();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const shortcutCloseRef = useRef<HTMLButtonElement>(null);
  const [announceMessage, setAnnounceMessage] = useState('');
  const [announceKind, setAnnounceKind] = useState<'success' | 'error' | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<BookingAction | null>(null);
  const [confirmationReason, setConfirmationReason] = useState('');

  useEffect(() => {
    if (!transactionId) return;
    setTransaction(getTransactionById(transactionId) ?? null);
    setDraft(getBookingDraftByTransactionId(transactionId) ?? null);
  }, [transactionId]);

  useEffect(() => {
    if (!onDirtyChange || !transactionId) return;
    const stored = getBookingDraftByTransactionId(transactionId);
    onDirtyChange(Boolean(draft && stored && JSON.stringify(draft) !== JSON.stringify(stored)));
  }, [draft, onDirtyChange, transactionId]);

  const permissionCtx = permissionContextForRole(role);
  const validationIssues = useMemo(() => {
    if (!transaction || !draft) return [];
    return validateBookingDraft(draft, transaction, defaultBookingPolicy);
  }, [draft, transaction]);

  const allowedActions = useMemo(() => {
    if (!draft) return [];
    const actions = getAllowedActions(draft.workflowStatus, permissionCtx, validationIssues);
    const readOnlyActions = new Set<BookingAction>();
    if (draft.workflowStatus === 'posted' || draft.workflowStatus === 'reversed') readOnlyActions.add('save_draft');
    if (transaction?.isVirtualPosted) {
      readOnlyActions.add('reverse');
      readOnlyActions.add('create_correction');
    }
    return actions.filter((action) => !readOnlyActions.has(action));
  }, [draft, permissionCtx, transaction, validationIssues]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The shortcut dialog itself is a Modal: it owns Escape and the focus trap.
      if (showShortcutHelp) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]') || target?.isContentEditable) return;
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcutHelp((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const primary = allowedActions.find((a) => ['post', 'approve', 'submit_for_review'].includes(a));
        // A hard error blocks the step; the shortcut must not fire what the button shows as locked.
        if (primary && (primary === 'approve' || !hasBlockingIssues(validationIssues))) {
          void handleWorkflowAction(primary);
        }
      }
      if (e.key === 'Escape') {
        setShowShortcutHelp(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [allowedActions, draft, transaction, role, showShortcutHelp, validationIssues]);

  if (!transactionId || !transaction || !draft) {
    return (
      <div className="rounded-card border border-border bg-surface px-5 py-10 text-center text-control text-muted">
        Keine Buchung ausgewählt.
      </div>
    );
  }

  const activeTransactionId = transaction.id;

  const readOnly =
    !permissionCtx.canMutate ||
    draft.workflowStatus === 'posted' ||
    draft.workflowStatus === 'reversed' ||
    (draft.workflowStatus === 'pending_approval' && role === 'bookkeeper');
  const readOnlyMessage =
    draft.workflowStatus === 'posted' || draft.workflowStatus === 'reversed'
      ? 'Gebuchte Buchungen sind gesperrt. Änderungen sind nur über eine Korrektur möglich.'
      : 'Diese Buchung ist schreibgeschützt.';

  const totalSoll = draft.lines
    .filter((line) => line.type === 'Soll')
    .reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const totalHaben = draft.lines
    .filter((line) => line.type === 'Haben')
    .reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const difference = Math.abs(totalSoll - totalHaben);
  const blocking = hasBlockingIssues(validationIssues);
  // Server-only checks (closed period, tax mapping, evidence) arrive on the stored draft; the ones the
  // editor recomputes live are taken from the current input, so a fixed field unblocks at once.
  const clientBlocking = validationIssues.filter((issue) => issue.blocking);
  const blockingIssues = [
    ...clientBlocking,
    ...draft.validationIssues.filter((issue) =>
      issue.blocking && !LIVE_CHECKED_CODES.has(issue.code) && !clientBlocking.some((own) => own.code === issue.code)),
  ];
  if (draft.workflowStatus === 'period_locked' && blockingIssues.length === 0) {
    blockingIssues.push({ id: 'period-locked', code: 'POSTING_DATE_IN_CLOSED_PERIOD', severity: 'error', message: 'Buchungsdatum liegt in einer gesperrten Periode.', blocking: true, source: 'system' });
  }
  // The next step a hard error holds back: shown disabled with its reason instead of disappearing.
  const blockedAction: BookingAction | undefined =
    blockingIssues.length === 0 || !permissionCtx.canMutate
      ? undefined
      : draft.workflowStatus === 'approved'
        ? permissionCtx.canPost ? 'post' : undefined
        : ['incomplete', 'suggested', 'ready_for_review', 'imported', 'period_locked'].includes(draft.workflowStatus)
          ? 'submit_for_review'
          : undefined;
  const blockedReason = blockingIssues.length === 0
    ? undefined
    : `${blockingIssues[0].message}${blockingIssues.length > 1 ? ` (+${blockingIssues.length - 1} weitere)` : ''}`;
  const privateAccounts = Object.values(PRIVATE_ACCOUNTS[draft.chartFramework] ?? {});
  // A GmbH/UG has no Privatkonten: their templates are left out.
  const chartTemplates = (BOOKING_TEMPLATES[draft.chartFramework] ?? []).filter((template) => !corporation || !privateAccounts.includes(template.accountId));
  const accountByNumber = new Map(accountOptions.map((account) => [account.number, account]));
  // Bank-booking convention (see createDraftFromTransaction): incoming money debits the bank line, outgoing credits it.
  const bankSide: JournalLine['type'] = Number(transaction?.amount) >= 0 ? 'Soll' : 'Haben';
  const bankLine = draft.lines.find((line) => line.type === bankSide && line.accountId);
  const templates = bankLine
    ? chartTemplates.filter((template) => template.direction === (bankSide === 'Soll' ? 'in' : 'out') && accountByNumber.has(template.accountId))
    : [];

  function patchDraft(updater: (prev: BookingDraft) => BookingDraft) {
    setDraft((prev) => (prev ? updater(prev) : prev));
  }

  function updateLine(id: string, updater: (line: JournalLine) => JournalLine) {
    patchDraft((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? updater(line) : line)),
    }));
  }

  function addLine() {
    if (readOnly) return;
    patchDraft((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        {
          id: `line-${Date.now()}`,
          accountId: '',
          accountName: '',
          type: 'Soll',
          amount: '',
          taxCode: '',
          taxCaseKey: undefined,
          taxRate: undefined,
          countryCode: '',
          counterpartyVatId: '',
          evidenceType: '',
          evidenceReference: '',
          costCenter: '',
        },
      ],
    }));
  }

  function applyTemplate(index: number) {
    const template = templates[index];
    if (readOnly || !template || !bankLine) return;
    const gross = Math.abs(Number(transaction?.amount) || 0);
    // The bank line stays; only the counter side is replaced by the template account.
    patchDraft((prev) => ({
      ...prev,
      lines: [
        { ...bankLine, amount: gross },
        {
          id: `line-${Date.now()}-template`,
          accountId: template.accountId,
          accountName: accountByNumber.get(template.accountId)?.name ?? template.accountId,
          type: bankSide === 'Soll' ? 'Haben' : 'Soll',
          amount: gross,
          taxCaseKey: template.taxCaseKey,
          taxCode: toLegacyTaxCode(template.taxCaseKey) ?? '',
          taxRate: findTaxCaseOption(template.taxCaseKey)?.defaultRate,
          costCenter: '',
        },
      ],
    }));
  }

  function removeLine(lineId: string) {
    if (readOnly) return;
    patchDraft((prev) => ({
      ...prev,
      lines: prev.lines.length <= 2 ? prev.lines : prev.lines.filter((line) => line.id !== lineId),
    }));
  }

  async function persistDraft(localDraft: BookingDraft) {
    const isCurrent = captureLifetime();
    const saved = await saveDraft(localDraft, role);
    if (!isCurrent()) return saved;
    // The server's answer is the stored draft; a store refresh in between may still carry the previous values.
    setDraft(saved);
    setTransaction(getTransactionById(activeTransactionId) ?? transaction);
    onStoreChange();
    return saved;
  }

  async function executeWorkflowAction(action: BookingAction, reason?: string) {
    if (!draft) return;
    const isCurrent = captureLifetime();
    setBusy(true);
    setAnnounceMessage('');
    setAnnounceKind(null);
    try {
      if (action === 'save_draft') {
        await persistDraft({ ...draft });
        if (!isCurrent()) return;
        setAnnounceMessage('Entwurf gespeichert');
        setAnnounceKind('success');
      } else {
        // A save sends the draft back to "Unvollständig" (the server owns the workflow), so only an edited draft
        // is saved first; otherwise "Freigeben" right after "Zur Prüfung geben" would fail.
        const stored = getBookingDraftByTransactionId(activeTransactionId);
        if (!stored || JSON.stringify(stored) !== JSON.stringify(draft)) {
          const saved = await saveDraft({ ...draft }, role);
          if (!isCurrent()) return;
          setDraft(saved);
        }
        const next = await dispatchBookingAction(activeTransactionId, action, {
          role,
          actorName: role,
          ...(action === 'reverse' && reason ? { rejectReason: reason } : {}),
        });
        if (!isCurrent()) return;
        setDraft(next);
        setTransaction(getTransactionById(activeTransactionId) ?? transaction);
        onStoreChange();
        setAnnounceMessage(ACTION_DONE[action] ?? 'Erledigt.');
        setAnnounceKind('success');
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? accountingErrorText(error.message) : 'Aktion fehlgeschlagen';
      setAnnounceMessage(message);
      setAnnounceKind('error');
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  function handleWorkflowAction(action: BookingAction) {
    if (!draft) return;
    if (actionRequiresConfirmation(action)) {
      setConfirmationAction(action);
      setConfirmationReason('');
      return;
    }
    void executeWorkflowAction(action);
  }

  const confirmationCopy = confirmationAction === 'reverse'
    ? {
      title: 'Buchung wirklich stornieren?',
      description: 'Die Buchung wird storniert und kann nicht direkt zurückgesetzt werden.',
      confirmLabel: 'Buchung stornieren',
    }
    : {
      title: 'Freigabe ablehnen?',
      description: 'Die Buchung wird zur Korrektur zurückgegeben.',
      confirmLabel: 'Freigabe ablehnen',
    };

  return (
    // Editor and aside are the second and third pane of the workbench grid in App.tsx.
    <div className="contents">
      <section aria-label="Buchung" className="flex min-w-0 flex-col rounded-card border border-border bg-surface">
        <div className="flex flex-col gap-2.25 border-b border-border px-3 py-2.5">
          <div className="flex items-start gap-2">
            <IconButton aria-label="Zurück zur Inbox" size="sm" className="-ml-1" onClick={onBack}>
              <ArrowLeft size={16} aria-hidden="true" />
            </IconButton>
            <div className="min-w-0 flex-1">
              <h2 className="sr-only">Buchung erfassen</h2>
              {/* The stepper below shows the workflow state; only states outside it and blockers get a pill. */}
              {(getWorkflowStep(draft.workflowStatus) < 0 || blocking || readOnly) && (
                <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                  {getWorkflowStep(draft.workflowStatus) < 0 && <StatusBadge status={draft.workflowStatus} />}
                  {blocking && <Badge tone="error"><ShieldAlert size={12} aria-hidden="true" /> Blockiert</Badge>}
                  {readOnly && <Badge tone="neutral"><Lock size={12} aria-hidden="true" /> Read-only</Badge>}
                </div>
              )}
              <div className="truncate text-section text-foreground">{transaction.payee}</div>
              <p className="truncate text-caption text-muted">
                {new Date(transaction.date).toLocaleDateString('de-DE')} • {transaction.description}
              </p>
            </div>
            <div className="shrink-0 font-mono text-heading font-bold tabular-nums text-foreground">
              {formatCurrency(transaction.amount, transaction.currency)}
            </div>
          </div>
          {getWorkflowStep(draft.workflowStatus) >= 0 && (
            <Stepper label="Bearbeitungsstand" steps={[...WORKFLOW_STEPS]} current={getWorkflowStep(draft.workflowStatus)} />
          )}
          {readOnly && <p className="text-caption text-muted" role="status">{readOnlyMessage}</p>}
        </div>

        <div className="flex min-w-0 flex-col gap-3.5 p-3">
          {announceMessage ? (
            <div
              className={`rounded-control border px-3 py-2.5 text-control ${announceKind === 'error' ? 'border-error-border bg-error-bg text-error-text' : 'border-success-border bg-success-bg text-success-text'}`}
              role={announceKind === 'error' ? 'alert' : 'status'}
              aria-live={announceKind === 'error' ? 'assertive' : 'polite'}
            >
              {announceMessage}
            </div>
          ) : null}

          <div>
            <h3 className="mb-2 text-eyebrow uppercase text-muted">Belegkopf</h3>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(148px,1fr))] gap-2.5">
              <Input
                id={`${editorId}-bookingeditor-belegdatum`}
                label="Belegdatum"
                type="date"
                fullWidth
                value={draft.documentDate ?? ''}
                disabled={readOnly}
                onChange={(e) => patchDraft((prev) => ({ ...prev, documentDate: e.target.value }))}
              />
              <Input
                label="Buchungsdatum *"
                type="date"
                fullWidth
                value={draft.postingDate ?? ''}
                disabled={readOnly}
                onChange={(e) => patchDraft((prev) => ({ ...prev, postingDate: e.target.value }))}
              />
              <Input
                label="Referenz / Belegnummer"
                type="text"
                fullWidth
                value={draft.externalReference ?? ''}
                disabled={readOnly}
                onChange={(e) => patchDraft((prev) => ({ ...prev, externalReference: e.target.value }))}
              />
            </div>
            <div className="mt-2.5">
              <Input
                id={`${editorId}-bookingeditor-buchungstext`}
                label="Buchungstext *"
                type="text"
                fullWidth
                value={draft.bookingText}
                disabled={readOnly}
                onChange={(e) => patchDraft((prev) => ({ ...prev, bookingText: e.target.value }))}
              />
            </div>
          </div>

          {!readOnly && templates.length > 0 && (
            <Select
              id={`${editorId}-booking-template`}
              label="Buchungsvorlage"
              fullWidth
              value=""
              onChange={(e) => {
                if (e.target.value !== '') applyTemplate(Number(e.target.value));
              }}
            >
              <option value="">Vorlage einsetzen…</option>
              {templates.map((template, index) => (
                <option key={template.label} value={index}>
                  {template.label} ({bankSide === 'Soll' ? `${bankLine?.accountId} an ${template.accountId}` : `${template.accountId} an ${bankLine?.accountId}`})
                </option>
              ))}
            </Select>
          )}

          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-eyebrow uppercase text-muted">Buchungssatz, {draft.chartFramework}</h3>
                <span className="text-caption text-muted">
                  {draft.lines.length} Zeilen • {blocking ? 'Blocker vorhanden' : 'Prüfbar'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={addLine} disabled={readOnly}>
                  <Plus size={14} aria-hidden="true" />
                  Zeile hinzufügen
                </Button>
                {!readOnly && (
                  <Button variant="ghost" size="sm" onClick={() => void handleWorkflowAction('save_draft')} disabled={busy}>
                    <Save size={14} aria-hidden="true" />
                    Speichern
                  </Button>
                )}
              </div>
            </div>

            <div className={`${LINE_GRID} pb-1.5 text-eyebrow uppercase text-muted`}>
              <div>S/H</div>
              <div>Konto</div>
              <div>Steuerfall</div>
              <div className="text-right">Betrag</div>
              <div><span className="sr-only">Zeile entfernen</span></div>
            </div>

            <div className="divide-y divide-border">
              {draft.lines.map((line) => {
                const selectedTaxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
                const selectedTaxCase = findTaxCaseOption(selectedTaxCaseKey);
                // The line books gross; the tax part is split off automatically from the tax case at posting.
                const autoTaxRate = line.taxRate ?? selectedTaxCase?.defaultRate ?? 0;
                const lineGross = Number(line.amount) || 0;
                // Reverse charge adds tax on top of the net line (input and output); standard VAT sits inside the gross.
                const reverseCharge = /(^|_)RC(_|$)/.test(selectedTaxCase?.key ?? '');
                // Same rounding as the server's enrichTaxFields, from the amount as currently typed.
                const round2 = (value: number) => Math.round(value * 100) / 100;
                const autoTaxAmount = reverseCharge
                  ? round2(lineGross * (autoTaxRate / 100))
                  : round2(lineGross - round2(lineGross / (1 + autoTaxRate / 100)));
                const autoTaxLabel = reverseCharge
                  ? `Vorsteuer und Umsatzsteuer ${autoTaxRate} % (Reverse Charge)`
                  : `${line.type === 'Soll' ? 'Vorsteuer' : 'Umsatzsteuer'} ${autoTaxRate} %`;
                return (
                  <div key={line.id} className="flex flex-col gap-2 py-2 first:pt-0.5">
                    <div className={`${LINE_GRID} items-center`}>
                      {/* Two-state switch: the side is a binary fact, not a list choice. */}
                      <div role="radiogroup" aria-label="Soll oder Haben" className="inline-flex h-8.5 overflow-hidden rounded-control border border-control-border">
                        {(['Soll', 'Haben'] as const).map((side) => (
                          <button
                            key={side}
                            type="button"
                            role="radio"
                            aria-checked={line.type === side}
                            aria-label={side}
                            disabled={readOnly}
                            onClick={() => updateLine(line.id, (current) => ({ ...current, type: side }))}
                            className={`min-w-9.5 flex-1 px-2.5 text-caption font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed ${line.type === side ? 'bg-selected text-selected-foreground' : 'bg-surface text-muted hover:text-foreground'} ${side === 'Haben' ? 'border-l border-border' : ''}`}
                          >
                            {side === 'Soll' ? 'S' : 'H'}
                          </button>
                        ))}
                      </div>

                      <AccountCombobox
                        accounts={accountOptions}
                        valueAccountId={line.accountId}
                        valueAccountName={line.accountName}
                        disabled={readOnly}
                        onSelect={(account) =>
                          updateLine(line.id, (current) => {
                            const normalized = normalizeTaxCaseKey(current.taxCaseKey ?? current.taxCode ?? account.defaultTaxCode);
                            const def = findTaxCaseOption(normalized);
                            return {
                              ...current,
                              accountId: account.number,
                              accountName: account.name,
                              taxCaseKey: normalized,
                              taxCode: toLegacyTaxCode(normalized) ?? current.taxCode ?? account.defaultTaxCode ?? '',
                              taxRate: current.taxRate ?? def?.defaultRate,
                            };
                          })
                        }
                      />

                      <Select
                        id={`${editorId}-tax-case-${line.id}`}
                        aria-label="Steuerfall"
                        fullWidth
                        value={selectedTaxCaseKey ?? ''}
                        disabled={readOnly}
                        onChange={(e) =>
                          updateLine(line.id, (current) => {
                            const nextTaxCase = normalizeTaxCaseKey(e.target.value);
                            const nextOption = findTaxCaseOption(nextTaxCase);
                            return {
                              ...current,
                              taxCaseKey: nextTaxCase,
                              taxCode: toLegacyTaxCode(nextTaxCase) ?? (nextTaxCase ?? ''),
                              taxRate: nextTaxCase ? current.taxRate ?? nextOption?.defaultRate : undefined,
                            };
                          })
                        }
                      >
                        <option value="">Keine</option>
                        {TAX_CASE_OPTIONS.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </Select>

                      <Input
                        id={`${editorId}-amount-${line.id}`}
                        aria-label="Betrag"
                        type="number"
                        step="0.01"
                        min="0"
                        fullWidth
                        className="text-right font-mono tabular-nums"
                        value={line.amount}
                        disabled={readOnly}
                        onChange={(e) =>
                          updateLine(line.id, (current) => ({ ...current, amount: parseAmountInput(e.target.value) }))
                        }
                      />

                      <IconButton
                        aria-label="Zeile löschen"
                        onClick={() => removeLine(line.id)}
                        disabled={readOnly || draft.lines.length <= 2}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </IconButton>
                    </div>

                    {selectedTaxCase && autoTaxRate > 0 && lineGross > 0 && (
                      <div
                        role="note"
                        aria-label={`Steuer automatisch: ${autoTaxLabel}`}
                        data-auto-tax-line
                        className={`${LINE_INDENT} flex flex-wrap items-center gap-2 text-caption text-muted`}
                      >
                        <Badge tone="info">Steuer automatisch</Badge>
                        <span>
                          {reverseCharge ? '' : 'davon '}{autoTaxLabel} aus dem Steuerfall:{' '}
                          <span className="font-mono font-semibold tabular-nums text-foreground">{formatCurrency(autoTaxAmount, transaction.currency)}</span>
                        </span>
                      </div>
                    )}

                    <div className={`${LINE_INDENT} grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2`}>
                      <Input
                        id={`${editorId}-cost-center-${line.id}`}
                        label="Kostenstelle"
                        type="text"
                        fullWidth
                        value={line.costCenter ?? ''}
                        disabled={readOnly}
                        onChange={(e) => updateLine(line.id, (current) => ({ ...current, costCenter: e.target.value }))}
                        placeholder="-"
                      />
                      {selectedTaxCase && (
                        <>
                          <Input
                            label="Steuersatz %"
                            type="number"
                            step="0.01"
                            min="0"
                            fullWidth
                            className="tabular-nums"
                            value={line.taxRate ?? ''}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateLine(line.id, (current) => ({
                                ...current,
                                taxRate: e.target.value === '' ? undefined : Number(parseAmountInput(e.target.value)),
                              }))
                            }
                          />
                          <Input
                            label="Land"
                            type="text"
                            fullWidth
                            value={line.countryCode ?? ''}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateLine(line.id, (current) => ({
                                ...current,
                                countryCode: e.target.value.toUpperCase(),
                              }))
                            }
                            placeholder={selectedTaxCase.requiresCountry ? 'Pflicht (z.B. FR)' : 'Optional'}
                          />
                          <Input
                            label="USt-IdNr."
                            type="text"
                            fullWidth
                            value={line.counterpartyVatId ?? ''}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateLine(line.id, (current) => ({
                                ...current,
                                counterpartyVatId: e.target.value.toUpperCase(),
                              }))
                            }
                            placeholder={selectedTaxCase.requiresCounterpartyVatId ? 'Pflicht' : 'Optional'}
                          />
                          <Input
                            label="Nachweisart"
                            type="text"
                            fullWidth
                            value={line.evidenceType ?? ''}
                            disabled={readOnly}
                            onChange={(e) => updateLine(line.id, (current) => ({ ...current, evidenceType: e.target.value }))}
                            placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
                          />
                          <Input
                            label="Nachweis-Referenz"
                            type="text"
                            fullWidth
                            value={line.evidenceReference ?? ''}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateLine(line.id, (current) => ({ ...current, evidenceReference: e.target.value }))
                            }
                            placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
                          />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* T-Konto: one figure split into its two sides, the difference named in euros. */}
            <section aria-label="Summen Soll und Haben" className="mt-3.5">
              <div className="grid grid-cols-[1fr_1px_1fr] border-t border-border-strong pt-2.5">
                <div className="pr-3.5">
                  <div className="text-eyebrow uppercase text-muted">Soll</div>
                  <div className="font-mono text-heading font-bold tabular-nums text-foreground">{formatCurrency(totalSoll, transaction.currency)}</div>
                </div>
                <div className="bg-border-strong" aria-hidden="true" />
                <div className="pl-3.5 text-right">
                  <div className="text-eyebrow uppercase text-muted">Haben</div>
                  <div className="font-mono text-heading font-bold tabular-nums text-foreground">{formatCurrency(totalHaben, transaction.currency)}</div>
                </div>
              </div>
              {difference < 0.01 ? (
                <p className="mt-2 flex items-center gap-1.5 text-caption text-success-text" role="status">
                  <Check size={14} aria-hidden="true" />
                  Soll und Haben gleichen sich aus
                </p>
              ) : (
                <div
                  className="mt-2.5 flex items-start gap-2.5 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text"
                  role="status"
                >
                  <TriangleAlert size={16} aria-hidden="true" className="mt-px shrink-0" />
                  <span className="min-w-0 flex-1">Differenz, Buchung nicht ausgeglichen</span>
                  <span className="font-mono font-semibold tabular-nums">{formatCurrency(difference, transaction.currency)}</span>
                </div>
              )}
            </section>
          </div>

          <WorkflowActionBar
            draft={draft}
            permissionCtx={permissionCtx}
            allowedActions={allowedActions}
            onAction={(action) => void handleWorkflowAction(action)}
            isBusy={busy}
            blockedAction={blockedAction}
            blockedReason={blockedReason}
          />
        </div>
      </section>

      <aside
        aria-label="Beleg, Prüfungen und Verlauf"
        className="flex min-w-0 flex-col gap-3.5 rounded-card border border-border bg-surface p-3 @2xl:col-span-2 @5xl:col-span-1"
      >
        <BankReceiptSection transactionId={transaction.id} hasReceipt={transaction.hasReceipt} canAttach={permissionCtx.canMutate} api={receiptApi} onAttached={onStoreChange} />
        <ValidationSummary issues={validationIssues} />
        <ActivityTimeline events={draft.activity} />
      </aside>

      <Modal
        open={showShortcutHelp}
        onClose={() => setShowShortcutHelp(false)}
        titleId={`${editorId}-shortcut-help-title`}
        initialFocusRef={shortcutCloseRef}
      >
        <div className="flex items-start gap-3 px-4.5 pb-2.5 pt-4">
          <h3 id={`${editorId}-shortcut-help-title`} className="min-w-0 flex-1 text-title text-foreground">Tastenkürzel</h3>
        </div>
        <ul className="flex flex-col gap-2 px-4.5 pb-4 pt-1 text-control text-foreground">
          <li><strong className="font-semibold">Ctrl/Cmd + Enter</strong>: Primäraktion ausführen (z. B. Freigeben/Buchen)</li>
          <li><strong className="font-semibold">?</strong>: Shortcut-Hilfe öffnen/schließen</li>
          <li><strong className="font-semibold">Esc</strong>: Dialog schließen</li>
        </ul>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
          <Button ref={shortcutCloseRef} variant="secondary" aria-label="Schließen (Tastenkürzel-Hilfe)" onClick={() => setShowShortcutHelp(false)}>
            Schließen
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmationAction !== null}
        title={confirmationCopy.title}
        description={confirmationCopy.description}
        confirmLabel={confirmationCopy.confirmLabel}
        cancelLabel="Abbrechen"
        destructive
        busy={busy}
        reason={confirmationAction === 'reverse' ? {
          label: 'Grund (Pflicht)',
          placeholder: 'Warum wird diese Buchung storniert?',
          required: true,
          value: confirmationReason,
          onChange: setConfirmationReason,
        } : undefined}
        details={confirmationAction === 'reverse' ? (
          <div className="space-y-2" aria-label="Buchung, die storniert wird">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-eyebrow uppercase text-muted">Betrag</div>
                <div className="font-mono font-semibold tabular-nums text-foreground">{formatCurrency(transaction.amount, transaction.currency)}</div>
              </div>
              <div>
                <div className="text-eyebrow uppercase text-muted">Soll / Haben</div>
                <div className="font-mono font-semibold tabular-nums text-foreground">
                  {formatCurrency(totalSoll, transaction.currency)} / {formatCurrency(totalHaben, transaction.currency)}
                </div>
              </div>
            </div>
            <div>
              <div className="text-eyebrow uppercase text-muted">Konten und Seiten</div>
              <ul className="mt-1 space-y-1 text-control text-foreground">
                {draft.lines.map((line) => (
                  <li key={line.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{line.accountId || line.accountName}</span>
                    <span className="shrink-0 font-mono font-semibold tabular-nums">{line.type} · {formatCurrency(Number(line.amount) || 0, transaction.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : undefined}
        onConfirm={() => {
          const action = confirmationAction;
          setConfirmationAction(null);
          const reason = confirmationReason.trim();
          setConfirmationReason('');
          if (action) void executeWorkflowAction(action, reason);
        }}
        onCancel={() => {
          setConfirmationAction(null);
          setConfirmationReason('');
        }}
      />
    </div>
  );
}
