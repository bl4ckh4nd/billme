import { useEffect, useMemo, useState } from 'react';
import { defaultBookingPolicy } from '../domain/policies';
import { getStatusPresentation } from '../domain/selectors';
import { hasBlockingIssues, validateBookingDraft } from '../domain/validation';
import { getAllowedActions } from '../domain/workflow';
import { permissionContextForRole } from '../mocks/users';
import {
  dispatchBookingAction,
  getBookingDraftByTransactionId,
  getTransactionById,
  saveDraft,
} from '../services/mockBookingStore';
import { BookingAction, BookingDraft, JournalLine, Transaction, UserRole } from '../types';
import ActivityTimeline from './ActivityTimeline';
import { actionRequiresConfirmation } from './booking-editor/helpers';
import BalanceSummaryBar from './booking-editor/BalanceSummaryBar';
import EditorHeader from './booking-editor/EditorHeader';
import JournalLineTable from './booking-editor/JournalLineTable';
import ReceiptPreviewPanel from './booking-editor/ReceiptPreviewPanel';
import ShortcutHelpModal from './booking-editor/ShortcutHelpModal';
import TransactionMetaPanel from './booking-editor/TransactionMetaPanel';

interface BookingEditorProps {
  transactionId: string | null;
  role: UserRole;
  onBack: () => void;
  onStoreChange: () => void;
}

export default function BookingEditor({ transactionId, role, onBack, onStoreChange }: BookingEditorProps) {
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [showReceipt, setShowReceipt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [announceMessage, setAnnounceMessage] = useState('');

  useEffect(() => {
    if (!transactionId) return;
    setTransaction(getTransactionById(transactionId) ?? null);
    setDraft(getBookingDraftByTransactionId(transactionId) ?? null);
  }, [transactionId]);

  const permissionCtx = permissionContextForRole(role);
  const validationIssues = useMemo(() => {
    if (!transaction || !draft) return [];
    return validateBookingDraft(draft, transaction, defaultBookingPolicy);
  }, [draft, transaction]);

  const allowedActions = useMemo(() => {
    if (!draft) return [];
    return getAllowedActions(draft.workflowStatus, permissionCtx, validationIssues);
  }, [draft, permissionCtx, validationIssues]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcutHelp((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const primary = allowedActions.find((a) => ['post', 'approve', 'submit_for_review'].includes(a));
        if (primary) {
          void handleWorkflowAction(primary);
        }
      }
      if (e.key === 'Escape') {
        setShowShortcutHelp(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [allowedActions, draft, transaction, role]);

  if (!transactionId || !transaction || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Keine Buchung ausgewählt.
      </div>
    );
  }

  const activeTransactionId = transaction.id;

  const readOnly =
    draft.workflowStatus === 'posted' ||
    draft.workflowStatus === 'reversed' ||
    (draft.workflowStatus === 'pending_approval' && role === 'bookkeeper');

  const totalSoll = draft.lines
    .filter((line) => line.type === 'Soll')
    .reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const totalHaben = draft.lines
    .filter((line) => line.type === 'Haben')
    .reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const difference = Math.abs(totalSoll - totalHaben);
  const blocking = hasBlockingIssues(validationIssues);
  const statusPresentation = getStatusPresentation(draft.workflowStatus);

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

  function removeLine(lineId: string) {
    if (readOnly) return;
    patchDraft((prev) => ({
      ...prev,
      lines: prev.lines.length <= 2 ? prev.lines : prev.lines.filter((line) => line.id !== lineId),
    }));
  }

  async function persistDraft(localDraft: BookingDraft) {
    const saved = saveDraft(localDraft, role);
    setDraft(saved);
    setTransaction(getTransactionById(activeTransactionId) ?? transaction);
    onStoreChange();
    return saved;
  }

  async function handleWorkflowAction(action: BookingAction) {
    if (!draft) return;
    if (actionRequiresConfirmation(action)) {
      const ok = window.confirm(
        action === 'reverse'
          ? 'Buchung wirklich stornieren?'
          : 'Freigabe ablehnen und zur Korrektur zurückgeben?',
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      if (action === 'save_draft') {
        await persistDraft({ ...draft });
        setAnnounceMessage('Entwurf gespeichert');
      } else {
        const saved = saveDraft({ ...draft }, role);
        setDraft(saved);
        const next = dispatchBookingAction(activeTransactionId, action, { role, actorName: role });
        setDraft(next);
        setTransaction(getTransactionById(activeTransactionId) ?? transaction);
        onStoreChange();
        setAnnounceMessage(`Aktion ausgeführt: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Aktion fehlgeschlagen';
      setAnnounceMessage(message);
      window.alert(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="sr-only" aria-live="polite">
        {announceMessage}
      </div>

      <EditorHeader
        transaction={transaction}
        draft={draft}
        blocking={blocking}
        readOnly={readOnly}
        statusPresentation={statusPresentation}
        permissionCtx={permissionCtx}
        allowedActions={allowedActions}
        busy={busy}
        onBack={onBack}
        onAction={(action) => void handleWorkflowAction(action)}
      />

      <div className="flex flex-1 overflow-hidden p-5 gap-5">
        <div className={`flex flex-col gap-4 ${showReceipt ? 'w-[30rem]' : 'w-[22rem]'} shrink-0`}>
          <TransactionMetaPanel
            draft={draft}
            transaction={transaction}
            readOnly={readOnly}
            showReceipt={showReceipt}
            onToggleReceipt={() => setShowReceipt((v) => !v)}
            onPatchDraft={patchDraft}
          />

          {showReceipt && <ReceiptPreviewPanel transaction={transaction} />}
        </div>

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <JournalLineTable
            draft={draft}
            readOnly={readOnly}
            busy={busy}
            blocking={blocking}
            validationIssues={validationIssues}
            onAddLine={addLine}
            onRemoveLine={removeLine}
            onUpdateLine={updateLine}
            onSaveDraft={() => void handleWorkflowAction('save_draft')}
          />

          <div className="mt-4 grid grid-cols-1 2xl:grid-cols-[1fr_20rem] gap-4">
            <BalanceSummaryBar
              totalSoll={totalSoll}
              totalHaben={totalHaben}
              difference={difference}
              currency={transaction.currency}
            />

            <ActivityTimeline events={draft.activity} />
          </div>
        </div>
      </div>

      <ShortcutHelpModal
        open={showShortcutHelp}
        onClose={() => setShowShortcutHelp(false)}
      />
    </div>
  );
}
