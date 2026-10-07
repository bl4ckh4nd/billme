import { z } from 'zod';
import { authUserSchema, serverProductSchema, serverRoleSchema, workspaceSummarySchema, type ServerProduct } from '@billme/server-core';

/**
 * The browser shell's calls to the account-level routes of a hosted server:
 * sign-up, workspaces, invitations and password reset. Session-scoped business
 * routes stay with the renderer's HTTP adapter.
 */

const sessionSchema = z.object({ token: z.string().min(1), user: authUserSchema, tenantId: z.string().min(1), product: serverProductSchema });
export type WorkspaceSession = z.infer<typeof sessionSchema>;

const invitationPreviewSchema = z.object({
  email: z.string(),
  role: serverRoleSchema,
  workspaceName: z.string(),
  product: serverProductSchema,
  userExists: z.boolean(),
});

const appsSchema = z.object({ lite: z.string().optional(), pro: z.string().optional() });

export const createWorkspaceClient = (apiUrl: string) => {
  const base = apiUrl.replace(/\/+$/, '');
  const request = async <T>(method: string, path: string, schema: z.ZodType<T>, options: { token?: string; body?: unknown } = {}): Promise<T> => {
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
  const ok = z.object({ ok: z.literal(true) });
  return {
    signUp: (product: ServerProduct, input: { email: string; password: string; fullName: string; workspaceName: string; setupToken?: string }) =>
      request('POST', `/api/v1/auth/signup?product=${product}`, sessionSchema, { body: input }),
    me: (product: ServerProduct, token: string) =>
      request('GET', `/api/v1/${product}/auth/me`, z.object({ tenantId: z.string(), user: authUserSchema }).passthrough(), { token }),
    listWorkspaces: (token: string) => request('GET', '/api/v1/auth/workspaces', z.array(workspaceSummarySchema), { token }),
    createWorkspace: (token: string, input: { name: string; product: ServerProduct; setupToken?: string }) =>
      request('POST', '/api/v1/auth/workspaces', sessionSchema, { token, body: input }),
    switchWorkspace: (product: ServerProduct, token: string, tenantId: string) =>
      request('POST', `/api/v1/auth/switch?product=${product}`, sessionSchema, { token, body: { tenantId } }),
    apps: () => request('GET', '/api/v1/auth/apps', appsSchema),
    describeInvitation: (token: string) => request('GET', `/api/v1/auth/invitations/${encodeURIComponent(token)}`, invitationPreviewSchema),
    acceptInvitation: (token: string, input: { password: string; fullName?: string }) =>
      request('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, sessionSchema, { body: input }),
    requestPasswordReset: (product: ServerProduct, email: string) =>
      request('POST', `/api/v1/auth/password-reset?product=${product}`, ok, { body: { email } }),
    confirmPasswordReset: (token: string, password: string) =>
      request('POST', '/api/v1/auth/password-reset/confirm', ok, { body: { token, password } }),
  };
};

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
