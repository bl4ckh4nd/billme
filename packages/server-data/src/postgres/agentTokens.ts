import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  agentTokenSummarySchema,
  createAgentTokenRequestSchema,
  type AgentScope,
  type AgentTokenSummary,
  type CreateAgentTokenRequest,
  type ServerProduct,
  type ServerRole,
} from '@billme/server-core';

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const createToken = (): string => `billme_agent_${randomBytes(32).toString('base64url')}`;

type AgentTokenRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  product: ServerProduct;
  label: string;
  scopes_json: string;
  created_at: string;
  revoked_at: string | null;
};

const toSummary = (row: AgentTokenRow): AgentTokenSummary => agentTokenSummarySchema.parse({
  id: row.id,
  label: row.label,
  product: row.product,
  scopes: JSON.parse(row.scopes_json) as AgentScope[],
  createdAt: row.created_at,
  revokedAt: row.revoked_at ?? undefined,
});

export const createPostgresAgentToken = async (
  pool: Pool,
  input: CreateAgentTokenRequest & {
    tenantId: string;
    userId: string;
    product: ServerProduct;
  },
): Promise<{ token: string; agent: AgentTokenSummary }> => {
  const parsed = createAgentTokenRequestSchema.parse(input);
  const token = createToken();
  const row: AgentTokenRow = {
    id: randomUUID(),
    tenant_id: input.tenantId,
    user_id: input.userId,
    product: input.product,
    label: parsed.label,
    scopes_json: JSON.stringify([...new Set(parsed.scopes)]),
    created_at: new Date().toISOString(),
    revoked_at: null,
  };
  await pool.query(
    `
      INSERT INTO agent_tokens (
        id, tenant_id, user_id, product, label, token_hash, scopes_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [row.id, row.tenant_id, row.user_id, row.product, row.label, hashToken(token), row.scopes_json, row.created_at],
  );
  return { token, agent: toSummary(row) };
};

export const listPostgresAgentTokens = async (
  pool: Pool,
  tenantId: string,
  product: ServerProduct,
): Promise<AgentTokenSummary[]> => {
  const result = await pool.query<AgentTokenRow>(
    `
      SELECT id, tenant_id, user_id, product, label, scopes_json, created_at, revoked_at
      FROM agent_tokens
      WHERE tenant_id = $1 AND product = $2
      ORDER BY created_at DESC, id DESC
    `,
    [tenantId, product],
  );
  return result.rows.map(toSummary);
};

export const revokePostgresAgentToken = async (
  pool: Pool,
  tenantId: string,
  product: ServerProduct,
  id: string,
): Promise<boolean> => {
  const result = await pool.query(
    `
      UPDATE agent_tokens
      SET revoked_at = COALESCE(revoked_at, $4)
      WHERE id = $1 AND tenant_id = $2 AND product = $3
      RETURNING id
    `,
    [id, tenantId, product, new Date().toISOString()],
  );
  return result.rowCount === 1;
};

export const verifyPostgresAgentToken = async (
  pool: Pool,
  token: string,
  product: ServerProduct,
): Promise<{
  id: string;
  tenantId: string;
  userId: string;
  product: ServerProduct;
  role: ServerRole;
  email: string;
  fullName: string;
  deploymentMode: 'single-tenant' | 'multi-tenant';
  scopes: AgentScope[];
} | null> => {
  const result = await pool.query<AgentTokenRow & {
    email: string;
    full_name: string;
    role: ServerRole;
    deployment_mode: 'single-tenant' | 'multi-tenant';
  }>(
    `
      SELECT
        token.id, token.tenant_id, token.user_id, token.product, token.label,
        token.scopes_json, token.created_at, token.revoked_at,
        users.email, users.full_name, memberships.role, tenants.deployment_mode
      FROM agent_tokens token
      JOIN user_accounts users ON users.id = token.user_id
      JOIN tenant_memberships memberships
        ON memberships.tenant_id = token.tenant_id AND memberships.user_id = token.user_id
      JOIN tenants ON tenants.id = token.tenant_id
      WHERE token.token_hash = $1
        AND token.product = $2
        AND token.revoked_at IS NULL
        AND users.status = 'active'
        AND tenants.status = 'active'
      LIMIT 1
    `,
    [hashToken(token), product],
  );
  const row = result.rows[0];
  if (!row) return null;
  await pool.query('UPDATE agent_tokens SET last_used_at = $2 WHERE id = $1', [row.id, new Date().toISOString()]);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    product: row.product,
    role: row.role,
    email: row.email,
    fullName: row.full_name,
    deploymentMode: row.deployment_mode,
    scopes: JSON.parse(row.scopes_json) as AgentScope[],
  };
};
