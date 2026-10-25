import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  normalizeEmailAddress,
  type AuthUser,
  type ServerProduct,
  type ServerRole,
} from '@billme/server-core';
import type { ServerDatabase, ServerDatabaseSession } from '../database.js';
import { createSalt, derivePasswordHash } from './auth.js';

/**
 * Hosted server mode as a multi-workspace service: a person owns or belongs to
 * several workspaces (tenants), owners and admins invite others by email, and a
 * forgotten password is reset through a mailed link. Tokens in links are random;
 * only their SHA-256 is stored.
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};

export interface WorkspaceSummary {
  readonly tenantId: string;
  readonly name: string;
  readonly product: ServerProduct;
  readonly role: ServerRole;
}

export interface WorkspaceMember {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: ServerRole;
  readonly joinedAt: string;
}

export interface WorkspaceInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: ServerRole;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface WorkspacePrincipal {
  readonly tenantId: string;
  readonly product: ServerProduct;
  readonly role: ServerRole;
  readonly user: AuthUser;
}

const slugFor = (name: string): string => {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
  return `${base}-${randomBytes(3).toString('hex')}`;
};

const insertWorkspace = async (session: ServerDatabaseSession, input: {
  name: string;
  product: ServerProduct;
  ownerUserId: string;
  initialSettingsJson: string;
  now: string;
}): Promise<string> => {
  const tenantId = randomUUID();
  await session.query(
    `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'single-tenant', 'active', $5, $5)`,
    [tenantId, slugFor(input.name), input.name, input.product, input.now],
  );
  await session.query(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', $4, $4)`,
    [randomUUID(), tenantId, input.ownerUserId, input.now],
  );
  await session.query(
    `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
    [tenantId, input.initialSettingsJson, input.now],
  );
  return tenantId;
};

const insertUser = async (session: ServerDatabaseSession, input: { email: string; password: string; fullName: string; now: string }): Promise<string> => {
  const userId = randomUUID();
  const salt = createSalt();
  await session.query(
    `INSERT INTO user_accounts (id, email, full_name, status, created_at, updated_at) VALUES ($1, $2, $3, 'active', $4, $4)`,
    [userId, input.email, input.fullName, input.now],
  );
  await session.query(
    `INSERT INTO user_password_credentials (user_id, password_salt, password_hash, password_algorithm, created_at, updated_at)
     VALUES ($1, $2, $3, 'scrypt-64', $4, $4)`,
    [userId, salt, derivePasswordHash(input.password, salt), input.now],
  );
  return userId;
};

const findUserByEmail = async (session: ServerDatabaseSession, email: string) =>
  (await session.query<{ id: string; email: string; full_name: string; status: string; password_salt: string | null; password_hash: string | null }>(
    `SELECT u.id, u.email, u.full_name, u.status, c.password_salt, c.password_hash
     FROM user_accounts u LEFT JOIN user_password_credentials c ON c.user_id = u.id
     WHERE lower(u.email) = $1`,
    [email],
  )).rows[0] ?? null;

const passwordMatches = (password: string, salt: string | null, hash: string | null): boolean => {
  if (!salt || !hash) return false;
  const candidate = Buffer.from(derivePasswordHash(password, salt), 'hex');
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
};

const membershipOf = async (session: ServerDatabaseSession, tenantId: string, userId: string) =>
  (await session.query<{ role: ServerRole; product: ServerProduct; name: string }>(
    `SELECT m.role, t.product, t.display_name AS name
     FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id JOIN user_accounts u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.user_id = $2 AND t.status = 'active' AND u.status = 'active'`,
    [tenantId, userId],
  )).rows[0] ?? null;

const userOf = async (session: ServerDatabaseSession, userId: string) =>
  (await session.query<{ id: string; email: string; full_name: string }>(
    'SELECT id, email, full_name FROM user_accounts WHERE id = $1',
    [userId],
  )).rows[0]!;

const principal = (tenantId: string, product: ServerProduct, role: ServerRole, user: { id: string; email: string; full_name: string }): WorkspacePrincipal => ({
  tenantId,
  product,
  role,
  user: { id: user.id, email: user.email, fullName: user.full_name, role },
});

const ownerCount = async (session: ServerDatabaseSession, tenantId: string): Promise<number> =>
  Number((await session.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM tenant_memberships m JOIN user_accounts u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.role = 'owner' AND u.status = 'active'`,
    [tenantId],
  )).rows[0]!.n);

export const createWorkspaceAccess = (database: ServerDatabase, options: { initialSettingsJson: string }) => ({
  /**
   * A new person and their first workspace in one step. An existing account
   * (e.g. Lite only, at the Pro set-up screen) adds the workspace with its own
   * password; wrong guesses count against the address like failed logins.
   */
  async signUp(input: { email: string; password: string; fullName: string; workspaceName: string; product: ServerProduct }): Promise<WorkspacePrincipal> {
    const email = normalizeEmailAddress(input.email);
    const existing = await findUserByEmail(database, email);
    if (existing) {
      const attempts = await database.query<{ attempt_count: number }>(`
        INSERT INTO login_attempts (product, email, attempt_count, window_started_at) VALUES ($1,$2,1,$3)
        ON CONFLICT (product,email) DO UPDATE SET
          attempt_count = CASE WHEN login_attempts.window_started_at <= $3::bigint - 900000 THEN 1 ELSE login_attempts.attempt_count + 1 END,
          window_started_at = CASE WHEN login_attempts.window_started_at <= $3::bigint - 900000 THEN $3::bigint ELSE login_attempts.window_started_at END
        RETURNING attempt_count`, [input.product, email, Date.now()]);
      if (Number(attempts.rows[0]!.attempt_count) > 5) fail(429, 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.');
      if (existing.status !== 'active' || !passwordMatches(input.password, existing.password_salt, existing.password_hash)) {
        fail(409, 'A user with this email already exists');
      }
      await database.query('DELETE FROM login_attempts WHERE product = $1 AND email = $2', [input.product, email]);
      return database.transaction({}, async (session) => {
        const tenantId = await insertWorkspace(session, { name: input.workspaceName.trim(), product: input.product, ownerUserId: existing.id, initialSettingsJson: options.initialSettingsJson, now: new Date().toISOString() });
        return principal(tenantId, input.product, 'owner', await userOf(session, existing.id));
      });
    }
    return database.transaction({ isolation: 'serializable' }, async (session) => {
      if (await findUserByEmail(session, email)) {
        fail(409, 'A user with this email already exists');
      }
      const now = new Date().toISOString();
      const userId = await insertUser(session, { email, password: input.password, fullName: input.fullName.trim(), now });
      const tenantId = await insertWorkspace(session, { name: input.workspaceName.trim(), product: input.product, ownerUserId: userId, initialSettingsJson: options.initialSettingsJson, now });
      return principal(tenantId, input.product, 'owner', await userOf(session, userId));
    });
  },

  /** Another workspace for a signed-in person, of either product. */
  async createWorkspace(userId: string, input: { name: string; product: ServerProduct }): Promise<WorkspacePrincipal> {
    return database.transaction({}, async (session) => {
      const now = new Date().toISOString();
      const tenantId = await insertWorkspace(session, { name: input.name.trim(), product: input.product, ownerUserId: userId, initialSettingsJson: options.initialSettingsJson, now });
      return principal(tenantId, input.product, 'owner', await userOf(session, userId));
    });
  },

  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    const rows = (await database.query<{ tenant_id: string; name: string; product: ServerProduct; role: ServerRole }>(
      `SELECT m.tenant_id, t.display_name AS name, t.product, m.role
       FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id JOIN user_accounts u ON u.id = m.user_id
       WHERE m.user_id = $1 AND t.status = 'active' AND u.status = 'active'
       ORDER BY t.display_name, t.created_at`,
      [userId],
    )).rows;
    return rows.map((row) => ({ tenantId: row.tenant_id, name: row.name, product: row.product, role: row.role }));
  },

  /** The session a person gets after switching to one of their workspaces. */
  async enterWorkspace(userId: string, tenantId: string, product: ServerProduct): Promise<WorkspacePrincipal> {
    const membership = await membershipOf(database, tenantId, userId);
    if (!membership) fail(403, 'You are not a member of this workspace');
    if (membership!.product !== product) fail(400, `This workspace belongs to Billme ${membership!.product === 'pro' ? 'Pro' : 'Lite'}`);
    return principal(tenantId, product, membership!.role, await userOf(database, userId));
  },

  async listMembers(tenantId: string): Promise<{ members: WorkspaceMember[]; invitations: WorkspaceInvitation[] }> {
    const members = (await database.query<{ user_id: string; email: string; full_name: string; role: ServerRole; created_at: string }>(
      `SELECT m.user_id, u.email, u.full_name, m.role, m.created_at
       FROM tenant_memberships m JOIN user_accounts u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND u.status = 'active' ORDER BY m.created_at, u.email`,
      [tenantId],
    )).rows;
    const invitations = (await database.query<{ id: string; email: string; role: ServerRole; created_at: string; expires_at: string }>(
      `SELECT id, email, role, created_at, expires_at FROM workspace_invitations
       WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
       ORDER BY created_at`,
      [tenantId, new Date().toISOString()],
    )).rows;
    return {
      members: members.map((row) => ({ userId: row.user_id, email: row.email, fullName: row.full_name, role: row.role, joinedAt: row.created_at })),
      invitations: invitations.map((row) => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at })),
    };
  },

  /** A new invitation replaces an open one for the same address. */
  async invite(tenantId: string, input: { email: string; role: ServerRole; invitedByUserId: string }): Promise<{ invitation: WorkspaceInvitation; token: string; workspaceName: string; product: ServerProduct }> {
    return database.transaction({}, async (session) => {
      const email = normalizeEmailAddress(input.email);
      const member = await session.query(
        `SELECT 1 FROM tenant_memberships m JOIN user_accounts u ON u.id = m.user_id WHERE m.tenant_id = $1 AND lower(u.email) = $2`,
        [tenantId, email],
      );
      if (member.rows.length) fail(409, 'This person is already a member of the workspace');
      const now = new Date();
      await session.query(
        `UPDATE workspace_invitations SET revoked_at = $3
         WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [tenantId, email, now.toISOString()],
      );
      const token = newToken();
      const invitation: WorkspaceInvitation = {
        id: randomUUID(),
        email,
        role: input.role,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
      };
      await session.query(
        `INSERT INTO workspace_invitations (id, tenant_id, email, role, token_hash, invited_by_user_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [invitation.id, tenantId, email, input.role, hashToken(token), input.invitedByUserId, invitation.createdAt, invitation.expiresAt],
      );
      const tenant = (await session.query<{ display_name: string; product: ServerProduct }>('SELECT display_name, product FROM tenants WHERE id = $1', [tenantId])).rows[0]!;
      return { invitation, token, workspaceName: tenant.display_name, product: tenant.product };
    });
  },

  async revokeInvitation(tenantId: string, invitationId: string): Promise<void> {
    const result = await database.query(
      `UPDATE workspace_invitations SET revoked_at = $3
       WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [tenantId, invitationId, new Date().toISOString()],
    );
    if (!(result.rowCount ?? result.affectedRows ?? 0)) fail(404, 'Invitation not found');
  },

  /** What the invitation page shows before the person decides. */
  async describeInvitation(token: string): Promise<{ email: string; role: ServerRole; workspaceName: string; product: ServerProduct; userExists: boolean }> {
    const row = (await database.query<{ email: string; role: ServerRole; expires_at: string; accepted_at: string | null; revoked_at: string | null; name: string; product: ServerProduct; status: string }>(
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, t.display_name AS name, t.product, t.status
       FROM workspace_invitations i JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = $1`,
      [hashToken(token)],
    )).rows[0];
    if (!row) fail(404, 'Invitation not found');
    if (row!.accepted_at || row!.revoked_at || row!.expires_at <= new Date().toISOString() || row!.status !== 'active') {
      fail(410, 'This invitation is no longer valid');
    }
    return { email: row!.email, role: row!.role, workspaceName: row!.name, product: row!.product, userExists: Boolean(await findUserByEmail(database, row!.email)) };
  },

  /**
   * Joins the workspace. A new person chooses a password and name; someone who
   * already has an account proves it with their password.
   */
  async acceptInvitation(token: string, input: { password: string; fullName?: string }): Promise<WorkspacePrincipal> {
    return database.transaction({ isolation: 'serializable' }, async (session) => {
      const invitation = (await session.query<{ id: string; tenant_id: string; email: string; role: ServerRole; expires_at: string; accepted_at: string | null; revoked_at: string | null; product: ServerProduct; status: string }>(
        `SELECT i.id, i.tenant_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, t.product, t.status
         FROM workspace_invitations i JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = $1 FOR UPDATE OF i`,
        [hashToken(token)],
      )).rows[0];
      if (!invitation) fail(404, 'Invitation not found');
      const now = new Date().toISOString();
      if (invitation!.accepted_at || invitation!.revoked_at || invitation!.expires_at <= now || invitation!.status !== 'active') {
        fail(410, 'This invitation is no longer valid');
      }
      const existing = await findUserByEmail(session, invitation!.email);
      let userId: string;
      if (existing) {
        if (existing.status !== 'active' || !passwordMatches(input.password, existing.password_salt, existing.password_hash)) {
          fail(401, 'Invalid email or password');
        }
        userId = existing.id;
      } else {
        if (!input.fullName?.trim()) fail(400, 'A name is required to create the account');
        if (input.password.length < 12) fail(400, 'The password needs at least 12 characters');
        userId = await insertUser(session, { email: invitation!.email, password: input.password, fullName: input.fullName!.trim(), now });
      }
      await session.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, invited_by_user_id, created_at, updated_at)
         SELECT $1, $2, $3, $4, invited_by_user_id, $5, $5 FROM workspace_invitations WHERE id = $6
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [randomUUID(), invitation!.tenant_id, userId, invitation!.role, now, invitation!.id],
      );
      await session.query('UPDATE workspace_invitations SET accepted_at = $2 WHERE id = $1', [invitation!.id, now]);
      const membership = await membershipOf(session, invitation!.tenant_id, userId);
      return principal(invitation!.tenant_id, invitation!.product, membership!.role, await userOf(session, userId));
    });
  },

  /** Changes a role; the last owner can neither be demoted nor removed. */
  async changeRole(tenantId: string, userId: string, role: ServerRole): Promise<void> {
    await database.transaction({ isolation: 'serializable' }, async (session) => {
      const current = await membershipOf(session, tenantId, userId);
      if (!current) fail(404, 'Member not found');
      if (current!.role === 'owner' && role !== 'owner' && await ownerCount(session, tenantId) <= 1) {
        fail(409, 'A workspace needs at least one owner');
      }
      await session.query('UPDATE tenant_memberships SET role = $3, updated_at = $4 WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId, role, new Date().toISOString()]);
    });
  },

  async removeMember(tenantId: string, userId: string): Promise<void> {
    await database.transaction({ isolation: 'serializable' }, async (session) => {
      const current = await membershipOf(session, tenantId, userId);
      if (!current) fail(404, 'Member not found');
      if (current!.role === 'owner' && await ownerCount(session, tenantId) <= 1) {
        fail(409, 'A workspace needs at least one owner');
      }
      await session.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
      await session.query('DELETE FROM cli_tokens WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    });
  },

  async roleOf(tenantId: string, userId: string): Promise<ServerRole | null> {
    return (await membershipOf(database, tenantId, userId))?.role ?? null;
  },

  /** Returns a reset token for an active account, null for an unknown address. */
  async requestPasswordReset(email: string): Promise<{ token: string; user: { email: string; fullName: string } } | null> {
    const user = await findUserByEmail(database, normalizeEmailAddress(email));
    if (!user || user.status !== 'active') return null;
    const token = newToken();
    const now = new Date();
    await database.query(
      `INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [hashToken(token), user.id, now.toISOString(), new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString()],
    );
    return { token, user: { email: user.email, fullName: user.full_name } };
  },

  /** Sets the new password once; it also lifts a login lockout and voids other reset links. */
  async resetPassword(token: string, password: string): Promise<void> {
    await database.transaction({}, async (session) => {
      const row = (await session.query<{ user_id: string; expires_at: string; used_at: string | null; email: string }>(
        `SELECT r.user_id, r.expires_at, r.used_at, u.email FROM password_reset_tokens r JOIN user_accounts u ON u.id = r.user_id
         WHERE r.token_hash = $1 FOR UPDATE OF r`,
        [hashToken(token)],
      )).rows[0];
      const now = new Date().toISOString();
      if (!row || row.used_at || row.expires_at <= now) fail(410, 'This reset link is no longer valid');
      const salt = createSalt();
      await session.query(
        `UPDATE user_password_credentials SET password_salt = $2, password_hash = $3, updated_at = $4 WHERE user_id = $1`,
        [row!.user_id, salt, derivePasswordHash(password, salt), now],
      );
      await session.query('UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [row!.user_id, now]);
      await session.query('DELETE FROM login_attempts WHERE email = $1', [normalizeEmailAddress(row!.email)]);
    });
  },
});

export type WorkspaceAccess = ReturnType<typeof createWorkspaceAccess>;
