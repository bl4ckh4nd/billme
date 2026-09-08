import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Info, LoaderCircle, XCircle } from 'lucide-react';
import { Portal } from './Portal';
import { Toast, type ToastAction } from './Toast';

export type FeedbackKind = 'success' | 'error' | 'info' | 'progress';

export interface FeedbackAction extends ToastAction {}

export interface FeedbackOptions {
  duration?: number;
  // ponytail: action labels are trusted to stay short; add truncation/validation when labels become user-authored.
  action?: FeedbackAction;
}

export interface ActionFeedback {
  notify: (kind: FeedbackKind, message: string, options?: FeedbackOptions) => void;
  clear: () => void;
}

interface FeedbackEntry extends FeedbackOptions {
  id: number;
  kind: FeedbackKind;
  message: string;
}

interface FeedbackContextValue {
  notify: (scope: string, kind: FeedbackKind, message: string, options?: FeedbackOptions) => void;
  clear: (scope: string) => void;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

const defaultDuration = (kind: FeedbackKind): number | null => {
  if (kind === 'progress') return null;
  return kind === 'error' ? 6000 : 3000;
};

const getDuration = (kind: FeedbackKind, options: FeedbackOptions): number | null => {
  if (options.action) return Math.max(8000, options.duration ?? 8000);
  if (kind === 'progress') return null;
  return options.duration ?? defaultDuration(kind);
};

const normalizedScope = (scope: string): string => scope.trim() || 'global';

const FeedbackIcon: React.FC<{ kind: FeedbackKind }> = ({ kind }) => {
  if (kind === 'progress') return <LoaderCircle size={16} className="shrink-0 animate-spin" aria-hidden="true" />;
  if (kind === 'error') return <XCircle size={16} aria-hidden="true" />;
  if (kind === 'info') return <Info size={16} aria-hidden="true" />;
  return <CheckCircle2 size={16} aria-hidden="true" />;
};

export const FeedbackProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [entries, setEntries] = useState<Record<string, FeedbackEntry>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const clearTimer = useCallback((scope: string) => {
    const timer = timers.current.get(scope);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(scope);
    }
  }, []);

  const clear = useCallback((scope: string) => {
    const key = normalizedScope(scope);
    clearTimer(key);
    setEntries((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, [clearTimer]);

  const notify = useCallback((scope: string, kind: FeedbackKind, message: string, options: FeedbackOptions = {}) => {
    const key = normalizedScope(scope);
    clearTimer(key);
    const id = ++nextId.current;
    const entry: FeedbackEntry = { id, kind, message, ...options };
    setEntries((current) => ({ ...current, [key]: entry }));

    const duration = getDuration(kind, options);
    if (duration === null || duration <= 0 || !Number.isFinite(duration)) return;

    const timer = setTimeout(() => {
      timers.current.delete(key);
      setEntries((current) => {
        if (current[key]?.id !== id) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, duration);
    timers.current.set(key, timer);
  }, [clearTimer]);

  useEffect(() => () => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
  }, []);

  const contextValue = useMemo(() => ({ notify, clear }), [clear, notify]);
  const visibleEntries = Object.entries(entries);

  return (
    <FeedbackContext.Provider value={contextValue}>
      {children}
      {visibleEntries.length > 0 && (
        <Portal>
          <div
            aria-label="Aktionsmeldungen"
            className="pointer-events-none fixed top-14 right-8 z-50 flex max-w-md flex-col items-end gap-3"
          >
            {visibleEntries.map(([scope, entry]) => (
              <Toast
                key={`${scope}-${entry.id}`}
                variant={entry.kind}
                size="compact"
                portal={false}
                action={entry.action ? {
                  label: entry.action.label,
                  onClick: () => {
                    clear(scope);
                    entry.action?.onClick();
                  },
                } : undefined}
                className="pointer-events-auto w-full"
              >
                <FeedbackIcon kind={entry.kind} />
                <span className="min-w-0 flex-1 text-sm font-bold">{entry.message}</span>
              </Toast>
            ))}
          </div>
        </Portal>
      )}
    </FeedbackContext.Provider>
  );
};

export const useActionFeedback = (scope: string): ActionFeedback => {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error('useActionFeedback must be used within FeedbackProvider');
  const key = normalizedScope(scope);
  return useMemo(() => ({
    notify: (kind: FeedbackKind, message: string, options?: FeedbackOptions) => context.notify(key, kind, message, options),
    clear: () => context.clear(key),
  }), [context, key]);
};
