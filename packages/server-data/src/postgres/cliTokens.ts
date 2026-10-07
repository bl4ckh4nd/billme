import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  CLI_TOKEN_PREFIX,
  cliTokenSummarySchema,
  type AuthUser,
  type CliTokenScope,
  type CliTokenSummary,
  type ServerProduct,
  type ServerRole,
} from '@billme/server-core';
import type { ServerDatabaseSession } from '../database.js';
import { createDrizzle, schema } from './drizzle.js';

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** `last_used_at` is for the token list, not an access log; one write per minute is enough. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface CliTokenOwner {
  readonly tenantId: string;
  readonly userId: string;
  readonly product: ServerProduct;
}

export interface ResolvedCliToken {
  readonly id: string;
  readonly label: string;
  readonly scope: CliTokenScope;
  readonly tenantId: string;
  readonly product: ServerProduct;
  readonly user: AuthUser;
}

const toSummary = (row: {
  id: string | null;
  label: string | null;
  product: string | null;
  scope: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}): CliTokenSummary => cliTokenSummarySchema.parse({
  id: row.id,
  label: row.label,
  product: row.product,
  scope: row.scope,
  createdAt: row.createdAt,
  ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
});

/** The plain token is returned once and never stored. */
export const createServerCliToken = async (
  database: ServerDatabaseSession,
  owner: CliTokenOwner,
  input: { label: string; scope: CliTokenScope },
): Promise<{ token: string; summary: CliTokenSummary }> => {
  const token = `${CLI_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const row = {
    id: randomUUID(),
    tenantId: owner.tenantId,
    userId: owner.userId,
    product: owner.product,
    label: input.label,
    tokenHash: hashToken(token),
    scope: input.scope,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  await createDrizzle(database).insert(schema.cliTokens).values(row);
  return { token, summary: toSummary(row) };
};

/**
 * Resolves a presented token to its user with the role that user holds now.
 * Revoked or expired tokens, inactive users and removed memberships all yield null.
 */
export const resolveServerCliToken = async (
  database: ServerDatabaseSession,
  token: string,
): Promise<ResolvedCliToken | null> => {
  const db = createDrizzle(database);
  const [row] = await db
    .select({
      id: schema.cliTokens.id,
      label: schema.cliTokens.label,
      scope: schema.cliTokens.scope,
      tenantId: schema.cliTokens.tenantId,
      product: schema.cliTokens.product,
      expiresAt: schema.cliTokens.expiresAt,
      lastUsedAt: schema.cliTokens.lastUsedAt,
      userId: schema.userAccounts.id,
      email: schema.userAccounts.email,
      fullName: schema.userAccounts.fullName,
      status: schema.userAccounts.status,
      role: schema.tenantMemberships.role,
    })
    .from(schema.cliTokens)
    .innerJoin(schema.userAccounts, eq(schema.userAccounts.id, schema.cliTokens.userId))
    .innerJoin(
      schema.tenantMemberships,
      and(
        eq(schema.tenantMemberships.userId, schema.cliTokens.userId),
        eq(schema.tenantMemberships.tenantId, schema.cliTokens.tenantId),
      ),
    )
    .where(and(eq(schema.cliTokens.tokenHash, hashToken(token)), isNull(schema.cliTokens.revokedAt)))
    .limit(1);

  if (!row || row.status !== 'active') return null;
  const now = Date.now();
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return null;

  if (!row.lastUsedAt || now - Date.parse(row.lastUsedAt) > LAST_USED_RESOLUTION_MS) {
    await db
      .update(schema.cliTokens)
      .set({ lastUsedAt: new Date(now).toISOString() })
      .where(eq(schema.cliTokens.id, row.id!));
  }

  return {
    id: row.id!,
    label: row.label!,
    scope: row.scope as CliTokenScope,
    tenantId: row.tenantId!,
    product: row.product as ServerProduct,
    user: {
      id: row.userId!,
      email: row.email!,
      fullName: row.fullName!,
      role: row.role as ServerRole,
    },
  };
};

const ownedBy = (owner: CliTokenOwner) => and(
  eq(schema.cliTokens.tenantId, owner.tenantId),
  eq(schema.cliTokens.product, owner.product),
  eq(schema.cliTokens.userId, owner.userId),
  isNull(schema.cliTokens.revokedAt),
);

/** A user's own active tokens, newest first. */
export const listServerCliTokens = async (
  database: ServerDatabaseSession,
  owner: CliTokenOwner,
): Promise<CliTokenSummary[]> => {
  const rows = await createDrizzle(database)
    .select()
    .from(schema.cliTokens)
    .where(ownedBy(owner))
    .orderBy(desc(schema.cliTokens.createdAt));
  return rows.map(toSummary);
};

/** Returns false when the token is not an active token of this user. */
export const revokeServerCliToken = async (
  database: ServerDatabaseSession,
  owner: CliTokenOwner,
  id: string,
): Promise<boolean> => {
  const revoked = await createDrizzle(database)
    .update(schema.cliTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(ownedBy(owner), eq(schema.cliTokens.id, id)))
    .returning({ id: schema.cliTokens.id });
  return revoked.length > 0;
};
