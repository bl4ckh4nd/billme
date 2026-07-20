const toHttpsOrigin = (value: string): string => {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Portal allowlist entries must be HTTPS origins');
  }
  return url.origin;
};

export const parsePortalAllowedOrigins = (value: string | undefined): ReadonlySet<string> => {
  if (!value?.trim()) {
    return new Set();
  }
  return new Set(value.split(',').map(toHttpsOrigin));
};

export const isPortalUrlAllowed = (baseUrl: string | undefined, allowedOrigins: ReadonlySet<string>): boolean => {
  if (!baseUrl?.trim()) {
    return true;
  }
  try {
    return allowedOrigins.has(toHttpsOrigin(baseUrl));
  } catch {
    return false;
  }
};
