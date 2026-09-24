import { useActionFeedback } from '@billme/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

export const DEFERRED_DELETE_DELAY_MS = 8000;
/** How long a deleted row stays rendered (faded out) before it leaves the list. */
export const DEFERRED_DELETE_LEAVE_MS = 180;

export interface UseDeferredDeleteOptions {
  scope: string;
  commit: (id: string) => Promise<unknown>;
  label: (count: number) => string;
}

export interface UseDeferredDeleteResult {
  pendingIds: ReadonlySet<string>;
  /**
   * Pending ids that are still fading out. Keep these rows rendered with
   * `data-leaving` (styled in @billme/ui styles.css) instead of hiding them;
   * empty when the user prefers reduced motion.
   */
  leavingIds: ReadonlySet<string>;
  requestDelete: (ids: string[]) => void;
  undo: () => void;
}

// ponytail: Deletes stay hard deletes, so this short deferred commit provides the
// requested undo window; a real soft-delete/restore API should replace this hook's queue.

type DeleteRecord = {
  id: string;
  batchId: number;
  timer: ReturnType<typeof setTimeout>;
  state: 'pending' | 'committing';
};

type DeleteBatch = {
  id: number;
  ids: string[];
};

export const useDeferredDelete = ({
  scope,
  commit,
  label,
}: UseDeferredDeleteOptions): UseDeferredDeleteResult => {
  const { notify, clear } = useActionFeedback(scope);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [leavingIds, setLeavingIds] = useState<Set<string>>(() => new Set());
  const leaveTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const recordsRef = useRef(new Map<string, DeleteRecord>());
  const batchesRef = useRef(new Map<number, DeleteBatch>());
  const activeBatchRef = useRef<DeleteBatch | null>(null);
  const nextBatchIdRef = useRef(0);
  const mountedRef = useRef(true);
  const commitRef = useRef(commit);
  const labelRef = useRef(label);
  const notifyRef = useRef(notify);
  const clearRef = useRef(clear);

  commitRef.current = commit;
  labelRef.current = label;
  notifyRef.current = notify;
  clearRef.current = clear;

  const publishPendingIds = useCallback(() => {
    if (mountedRef.current) setPendingIds(new Set(pendingIdsRef.current));
  }, []);

  const commitRecord = useCallback((id: string) => {
    const record = recordsRef.current.get(id);
    if (!record || record.state !== 'pending') return;

    clearTimeout(record.timer);
    record.state = 'committing';
    recordsRef.current.delete(id);

    let result: Promise<unknown>;
    try {
      result = commitRef.current(id);
    } catch (error) {
      pendingIdsRef.current.delete(id);
      publishPendingIds();
      if (mountedRef.current) {
        notifyRef.current('error', formatDeleteError(error));
      }
      return;
    }

    void result.then(
      () => {
        pendingIdsRef.current.delete(id);
        publishPendingIds();
      },
      (error: unknown) => {
        pendingIdsRef.current.delete(id);
        publishPendingIds();
        if (mountedRef.current) {
          notifyRef.current('error', formatDeleteError(error));
        }
      },
    );
  }, [publishPendingIds]);

  const undoBatch = useCallback((batchId: number) => {
    const batch = batchesRef.current.get(batchId);
    if (!batch) return;

    if (activeBatchRef.current?.id === batchId) activeBatchRef.current = null;
    batchesRef.current.delete(batchId);

    for (const id of batch.ids) {
      const record = recordsRef.current.get(id);
      if (!record || record.batchId !== batchId || record.state !== 'pending') continue;
      clearTimeout(record.timer);
      recordsRef.current.delete(id);
      pendingIdsRef.current.delete(id);
    }
    publishPendingIds();
    setLeavingIds((current) => withoutIds(current, batch.ids));
  }, [publishPendingIds]);

  const requestDelete = useCallback((ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids.filter((id) => id && !pendingIdsRef.current.has(id))));
    if (uniqueIds.length === 0) return;

    const batch: DeleteBatch = {
      id: ++nextBatchIdRef.current,
      ids: uniqueIds,
    };
    batchesRef.current.set(batch.id, batch);
    activeBatchRef.current = batch;

    for (const id of uniqueIds) {
      const record = {
        id,
        batchId: batch.id,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        state: 'pending' as const,
      };
      recordsRef.current.set(id, record);
      pendingIdsRef.current.add(id);
      record.timer = setTimeout(() => commitRecord(id), DEFERRED_DELETE_DELAY_MS);
    }
    publishPendingIds();
    if (!prefersReducedMotion()) {
      setLeavingIds((current) => new Set([...current, ...uniqueIds]));
      const timer = setTimeout(() => {
        leaveTimersRef.current.delete(timer);
        if (mountedRef.current) setLeavingIds((current) => withoutIds(current, uniqueIds));
      }, DEFERRED_DELETE_LEAVE_MS);
      leaveTimersRef.current.add(timer);
    }

    notifyRef.current('success', labelRef.current(uniqueIds.length), {
      action: {
        label: 'Rückgängig',
        onClick: () => undoBatch(batch.id),
      },
    });
  }, [commitRecord, publishPendingIds, undoBatch]);

  const undo = useCallback(() => {
    const activeBatch = activeBatchRef.current;
    if (activeBatch) undoBatch(activeBatch.id);
  }, [undoBatch]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of leaveTimersRef.current) clearTimeout(timer);
      leaveTimersRef.current.clear();
      const records = Array.from(recordsRef.current.values());
      for (const record of records) {
        if (record.state !== 'pending') continue;
        clearTimeout(record.timer);
        commitRecord(record.id);
      }
      recordsRef.current.clear();
      batchesRef.current.clear();
      activeBatchRef.current = null;
      // The toast lives above the router; without this it would keep offering an Undo that can no longer work.
      if (records.length > 0) clearRef.current();
    };
  }, [commitRecord]);

  return { pendingIds, leavingIds, requestDelete, undo };
};

const withoutIds = (current: Set<string>, ids: string[]): Set<string> => {
  if (!ids.some((id) => current.has(id))) return current;
  const next = new Set(current);
  for (const id of ids) next.delete(id);
  return next;
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const formatDeleteError = (error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);
  return detail && detail !== 'undefined' ? `Löschen fehlgeschlagen: ${detail}` : 'Löschen fehlgeschlagen.';
};
