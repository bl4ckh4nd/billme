import {
  invitationPreviewSchema,
  okResultSchema,
  productAppsSchema,
  sessionTenantSchema,
  workspaceListSchema,
  workspaceSessionSchema,
  type ServerProduct,
  type WorkspaceSession,
} from '@billme/server-core';

/**
 * The browser shell's calls to the account-level routes of a hosted server:
 * sign-up, workspaces, invitations and password reset. Session-scoped business
 * routes stay with the renderer's HTTP adapter.
 */

export type { WorkspaceSession };

type Parser<T> = { parse: (value: unknown) => T };

export const createWorkspaceClient = (apiUrl: string) => {
  const base = apiUrl.replace(/\/+$/, '');
  const request = async <T>(method: string, path: string, schema: Parser<T>, options: { token?: string; body?: unknown } = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    if (!response.ok) {
      throw Object.assign(new Error(payload?.message ?? `Anfrage fehlgeschlagen (HTTP ${response.status}).`), { status: response.status });
    }
    return schema.parse(payload);
  };
  return {
    signUp: (product: ServerProduct, input: { email: string; password: string; fullName: string; workspaceName: string; setupToken?: string }) =>
      request('POST', `/api/v1/auth/signup?product=${product}`, workspaceSessionSchema, { body: input }),
    me: (product: ServerProduct, token: string) =>
      request('GET', `/api/v1/${product}/auth/me`, sessionTenantSchema, { token }),
    listWorkspaces: (token: string) => request('GET', '/api/v1/auth/workspaces', workspaceListSchema, { token }),
    createWorkspace: (token: string, input: { name: string; product: ServerProduct; setupToken?: string }) =>
      request('POST', '/api/v1/auth/workspaces', workspaceSessionSchema, { token, body: input }),
    switchWorkspace: (product: ServerProduct, token: string, tenantId: string) =>
      request('POST', `/api/v1/auth/switch?product=${product}`, workspaceSessionSchema, { token, body: { tenantId } }),
    apps: () => request('GET', '/api/v1/auth/apps', productAppsSchema),
    describeInvitation: (token: string) => request('GET', `/api/v1/auth/invitations/${encodeURIComponent(token)}`, invitationPreviewSchema),
    acceptInvitation: (token: string, input: { password: string; fullName?: string }) =>
      request('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, workspaceSessionSchema, { body: input }),
    requestPasswordReset: (product: ServerProduct, email: string) =>
      request('POST', `/api/v1/auth/password-reset?product=${product}`, okResultSchema, { body: { email } }),
    confirmPasswordReset: (token: string, password: string) =>
      request('POST', '/api/v1/auth/password-reset/confirm', okResultSchema, { body: { token, password } }),
  };
};

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
