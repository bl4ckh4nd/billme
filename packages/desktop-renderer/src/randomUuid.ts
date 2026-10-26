/**
 * `crypto.randomUUID` exists only in a secure context (HTTPS or localhost). A browser shell served over plain http
 * in the LAN (e.g. http://10.20.30.51:4186) has `crypto.getRandomValues` but not `randomUUID`; the app calls it for
 * keys and idempotency keys. This adds it there: an RFC 4122 version 4 UUID from the same random source.
 */
export const randomUuidFrom = (getRandomValues: (bytes: Uint8Array) => Uint8Array): string => {
  const bytes = getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const ensureRandomUuid = (): void => {
  const cryptoApi = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  if (!cryptoApi || typeof cryptoApi.randomUUID === 'function' || typeof cryptoApi.getRandomValues !== 'function') return;
  Object.defineProperty(cryptoApi, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => randomUuidFrom((bytes) => cryptoApi.getRandomValues(bytes)),
  });
};
