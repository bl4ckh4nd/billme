import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

// Per-device display preference, not business data: it stays in the browser
// profile of each shell and never reaches the backend.
const STORAGE_KEY = 'billme.theme';
const listeners = new Set<() => void>();

const read = (): ThemePreference => {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
};

let current: ThemePreference = read();

const apply = (preference: ThemePreference) => {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
};

/** Writes the stored preference to <html data-theme>. */
const applyStoredTheme = () => apply(current);

// Every renderer entry (Lite, Pro, both web shells, demo) imports @billme/ui, so
// applying on load covers them all before the first paint of React content.
applyStoredTheme();

export const setThemePreference = (preference: ThemePreference) => {
  current = preference;
  try {
    if (preference === 'system') globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (private mode, locked profile); the choice still applies for this session.
  }
  apply(preference);
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useThemePreference = (): [ThemePreference, (preference: ThemePreference) => void] => [
  useSyncExternalStore(subscribe, () => current, () => 'system' as ThemePreference),
  setThemePreference,
];
