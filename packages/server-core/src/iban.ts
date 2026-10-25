/** IBAN as stored: without spaces, upper case. */
export const normalizeIban = (value: string): string => value.replace(/\s+/g, '').toUpperCase();

/**
 * Why an IBAN is not usable, as a German sentence for the form; undefined when it is empty or valid
 * (format, length for DE, ISO 13616 mod-97 check digits).
 */
export const ibanError = (value: string): string | undefined => {
  const iban = normalizeIban(value);
  if (!iban) return undefined;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return 'Die IBAN hat nicht das richtige Format (z. B. DE89 3704 0044 0532 0130 00).';
  if (iban.startsWith('DE') && iban.length !== 22) return 'Eine deutsche IBAN hat 22 Stellen.';
  let remainder = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    for (const digit of /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? undefined : 'Die Prüfziffer der IBAN stimmt nicht. Bitte auf Tippfehler prüfen.';
};

/** Groups of four for display: DE89 3704 0044 0532 0130 00. */
export const formatIban = (value: string): string => normalizeIban(value).replace(/(.{4})(?=.)/g, '$1 ');
