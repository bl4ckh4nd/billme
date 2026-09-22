/**
 * Presentation conventions shared by every surface.
 */

/**
 * Glyph for a missing value.
 *
 * En dash, never an em dash: the copy rules forbid the em dash character in any
 * rendered text, and the en dash is the German convention for "no value".
 */
export const EMPTY_VALUE = '–';

/**
 * Renders a value or the shared empty glyph. Use this instead of inlining
 * `?? '–'` so the convention lives in one place.
 */
export const formatEmptyValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return EMPTY_VALUE;
  if (typeof value === 'string' && value.trim() === '') return EMPTY_VALUE;
  return String(value);
};
