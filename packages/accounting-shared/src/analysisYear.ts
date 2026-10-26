/**
 * The year a person looks at in the analyses (Übersicht, Steuer, Geldkonten, Geschäftspartner): chosen in one, the
 * others open on it. Kept for the browser session only; `all` means every year.
 */
const KEY = 'billme.analysisYear';
export const ANALYSIS_YEAR_EVENT = 'billme:analysis-year';
const VALID = /^(\d{4}|all)$/;
/** The browser parts this needs; the package also builds for Node, without DOM types. */
type BrowserGlobals = {
  sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  dispatchEvent?: (event: unknown) => boolean;
  CustomEvent?: new (type: string, init: { detail: string }) => unknown;
};
const browser = globalThis as unknown as BrowserGlobals;

export const readAnalysisYear = (): string | undefined => {
  try {
    const value = browser.sessionStorage?.getItem(KEY) ?? undefined;
    return value && VALID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const writeAnalysisYear = (value: string): void => {
  if (!VALID.test(value)) return;
  try {
    browser.sessionStorage?.setItem(KEY, value);
  } catch {
    // Private mode or no storage: the choice stays on this screen only.
  }
  if (browser.dispatchEvent && browser.CustomEvent) browser.dispatchEvent(new browser.CustomEvent(ANALYSIS_YEAR_EVENT, { detail: value }));
};
