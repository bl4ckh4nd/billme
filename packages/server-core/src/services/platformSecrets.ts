/**
 * Hosted servers hold one SMTP password and one portal key for every workspace.
 * A workspace owner chooses the SMTP host and the portal address in settings, so
 * the secret may only travel to the endpoint the operator pinned in the server
 * environment; otherwise one workspace could collect the platform's credentials.
 */
const normalizeEndpoint = (value: string | undefined): string =>
  (value ?? '').trim().toLowerCase().replace(/\/+$/, '');

export const assertPinnedEndpoint = (args: {
  /** What the workspace configured (SMTP host or portal base URL). */
  configured: string | undefined;
  /** The operator's pin from the environment. */
  pinned: string | undefined;
  /** Name of the environment variable holding the pin, for the error message. */
  pinnedEnvName: string;
  label: string;
}): void => {
  const pinned = normalizeEndpoint(args.pinned);
  if (!pinned) {
    throw new Error(`${args.label}: Der Server gibt sein Zugangsgeheimnis nur an eine feste Adresse weiter. Bitte ${args.pinnedEnvName} setzen.`);
  }
  if (normalizeEndpoint(args.configured) !== pinned) {
    throw new Error(`${args.label}: ${args.configured?.trim() || '(leer)'} ist auf diesem Server nicht freigegeben. Erlaubt ist nur ${args.pinned?.trim()}.`);
  }
};
