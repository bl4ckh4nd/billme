/**
 * Belegfelder zeigen nur fachliche Werte. Rohe UUIDs und generierte Vorgangs-IDs
 * (etwa `sonderbuchung-1789547678430`) gehören in die technischen Details, nicht
 * in den Belegkopf; solche Werte werden ausgelassen statt angezeigt.
 */
const TECHNICAL_ID_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{32,}$/i,
  /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*-(?:1[0-9]{12}|[0-9]{13,})$/,
];

/** Fachliche Belegnummern (`RE-…`, `ANG-…`, `KD-…`) bleiben erhalten, technische Kennungen entfallen. */
export const userFacingReference = (value: string | null | undefined): string | undefined => {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  return TECHNICAL_ID_PATTERNS.some((pattern) => pattern.test(candidate)) ? undefined : candidate;
};
