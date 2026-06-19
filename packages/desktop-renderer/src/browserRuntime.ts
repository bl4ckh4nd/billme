export type Parser<T> = { parse: (input: unknown) => T } | ((input: unknown) => T);

export const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

export const buildUrl = (
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string => {
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
};

export const parseResponseError = (status: number, payload: unknown): Error => {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return new Error(payload.message);
  }
  return new Error(`Request failed with status ${status}`);
};

export const parseWith = <T>(parser: Parser<T>, input: unknown): T => {
  if (typeof parser === 'function') {
    return parser(input);
  }
  return parser.parse(input);
};

export const parseArray = <T>(itemParser: Parser<T>) => (input: unknown): T[] => {
  if (!Array.isArray(input)) {
    throw new Error('Expected array response');
  }
  return input.map((item) => parseWith(itemParser, item));
};

export const readJsonStorage = <T>(key: string, fallback: T, parser: (input: unknown) => T): T => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return parser(JSON.parse(raw));
  } catch {
    return fallback;
  }
};

export const writeJsonStorage = (key: string, value: unknown): void => {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
};

export const toIsoDate = (value: Date): string => value.toISOString().split('T')[0] ?? value.toISOString();

export const addDays = (value: string, days: number): string => {
  if (!days) return value;
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return toIsoDate(next);
};

export const buildPrintUrl = (kind: 'invoice' | 'offer' | 'eur', params: Record<string, string>): string => {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('__print', '1');
  url.searchParams.set('__autoprint', '1');
  url.searchParams.set('kind', kind);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
};

export const formatSemicolonCsv = (rows: Array<Record<string, unknown>>, headers: string[]): string => {
  const escapeCell = (value: unknown) => {
    const text = value == null ? '' : String(value);
    if (/[",;\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  return [headers.join(';'), ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(';'))].join('\n');
};
