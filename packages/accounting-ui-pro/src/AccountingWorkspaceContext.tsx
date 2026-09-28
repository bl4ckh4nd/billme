import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { defaultAccountingStore } from './services/mockBookingStore';

export const AccountingWorkspaceContext = createContext(defaultAccountingStore);

export function useAccountingWorkspace() {
  const store = useContext(AccountingWorkspaceContext);
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return store;
}

export function useWorkspaceLifetime(identity?: unknown) {
  const lifetime = useRef(0);
  useLayoutEffect(() => {
    lifetime.current++;
    return () => { lifetime.current++; };
  }, [identity]);
  return () => {
    const current = lifetime.current;
    return () => current === lifetime.current;
  };
}
