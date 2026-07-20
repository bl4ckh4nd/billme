import { randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import {
  normalizeEmailAddress,
  type AddTenantUserRequest,
  type AuthUser,
  type BootstrapRequest,
  type BootstrapStatus,
  type CreateWorkspaceRequest,
  type LoginRequest,
  type PlatformTenantSummary,
  type PlatformTenantUserSummary,
  type ServerProduct,
  type ServerRole,
  type UserAccount,
} from '@billme/server-core';
import { withSerializablePostgresTransaction } from './connection.js';
import { createPostgresBillingDependencies } from './billing.js';

export interface ServerAuthStore {
  getBootstrapStatus(product: ServerProduct): Promise<BootstrapStatus>;
  bootstrap(product: ServerProduct, input: BootstrapRequest): Promise<{
    tenantId: string;
    product: ServerProduct;
    role: ServerRole;
    user: AuthUser;
  }>;
  login(product: ServerProduct, input: LoginRequest): Promise<{
    tenantId: string;
    product: ServerProduct;
    role: ServerRole;
    user: AuthUser;
  }>;
}

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keyLength: number) => Promise<Buffer>;
const derivePasswordHash = async (password: string, salt: string): Promise<string> =>
  (await scryptAsync(password, salt, 64)).toString('hex');

const createSalt = (): string => randomUUID().replaceAll('-', '');

const createTenantSeed = (product: ServerProduct) => {
  const suffix = product === 'pro' ? 'pro' : 'lite';
  const label = product === 'pro' ? 'Billme Pro' : 'Billme';
  return {
    id: randomUUID(),
    slug: `${suffix}-primary`,
    displayName: label,
    product,
    deploymentMode: 'single-tenant' as const,
    status: 'active' as const,
  };
};

const toAuthResponse = (
  tenantId: string,
  product: ServerProduct,
  user: Pick<UserAccount, 'id' | 'email' | 'fullName'> & { role: 'owner' | 'admin' | 'accountant' | 'sales' | 'viewer' },
): {
  tenantId: string;
  product: ServerProduct;
  role: ServerRole;
  user: AuthUser;
} => ({
  tenantId,
  product,
  role: user.role,
  user: {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
  },
});

interface TenantSeed {
  id: string;
  slug: string;
  displayName: string;
  product: ServerProduct;
  deploymentMode: 'single-tenant' | 'multi-tenant';
  status: 'active';
}

interface OwnerSeed {
  email: string;
  fullName: string;
  password: string;
}

const provisionTenantWithOwner = async (
  client: PoolClient,
  tenant: TenantSeed,
  owner: OwnerSeed,
): Promise<{
  tenantId: string;
  product: ServerProduct;
  role: ServerRole;
  user: AuthUser;
}> => {
  const email = normalizeEmailAddress(owner.email);
  const existingUser = await client.query<{ id: string }>('SELECT id FROM user_accounts WHERE lower(email) = lower($1) LIMIT 1', [email]);
  if (existingUser.rows[0]) {
    throw new Error('A user with this email already exists');
  }

  const now = new Date().toISOString();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const salt = createSalt();
  const dependencies = createPostgresBillingDependencies(client);
  const scope = { tenantId: tenant.id, product: tenant.product, deploymentMode: tenant.deploymentMode };
  await dependencies.tenantRepo.save({
    ...tenant,
    createdAt: now,
    updatedAt: now,
  });
  await dependencies.userRepo.save(scope, {
    id: userId,
    email,
    fullName: owner.fullName.trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await dependencies.membershipRepo.save(scope, {
    id: membershipId,
    tenantId: tenant.id,
    userId,
    role: 'owner',
    createdAt: now,
    updatedAt: now,
  });
  await client.query(
    `
      INSERT INTO user_password_credentials (
        user_id, password_salt, password_hash, password_algorithm, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6
      )
    `,
    [userId, salt, await derivePasswordHash(owner.password, salt), 'scrypt-64', now, now],
  );

  return toAuthResponse(tenant.id, tenant.product, {
    id: userId,
    email,
    fullName: owner.fullName.trim(),
    role: 'owner',
  });
};

export const createTenantAsPlatformAdmin = async (
  pool: Pool,
  input: CreateWorkspaceRequest,
): Promise<PlatformTenantSummary> => {
  return withSerializablePostgresTransaction(pool, async (client) => {
    const existingSlug = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1 LIMIT 1', [input.slug]);
    if (existingSlug.rows[0]) {
      throw new Error(`A workspace with slug "${input.slug}" already exists`);
    }

    const tenant: TenantSeed = {
      id: randomUUID(),
      slug: input.slug,
      displayName: input.displayName,
      product: input.product,
      deploymentMode: 'multi-tenant',
      status: 'active',
    };

    await provisionTenantWithOwner(client, tenant, {
      email: input.ownerEmail,
      fullName: input.ownerFullName,
      password: input.ownerPassword,
    });

    const now = new Date().toISOString();
    return {
      id: tenant.id,
      slug: tenant.slug,
      displayName: tenant.displayName,
      product: tenant.product,
      status: tenant.status,
      memberCount: 1,
      createdAt: now,
    };
  });
};

export const listTenants = async (pool: Pool): Promise<PlatformTenantSummary[]> => {
  const result = await pool.query<{
    id: string;
    slug: string;
    display_name: string;
    product: ServerProduct;
    status: 'provisioning' | 'active' | 'suspended' | 'archived';
    member_count: string;
    created_at: string;
  }>(
    `
      SELECT
        t.id,
        t.slug,
        t.display_name,
        t.product,
        t.status,
        COUNT(m.id)::text AS member_count,
        t.created_at
      FROM tenants t
      LEFT JOIN tenant_memberships m ON m.tenant_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at ASC
    `,
  );
  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    product: row.product,
    status: row.status,
    memberCount: Number(row.member_count),
    createdAt: row.created_at,
  }));
};

export const listTenantUsers = async (pool: Pool, tenantId: string): Promise<PlatformTenantUserSummary[]> => {
  const result = await pool.query<{
    id: string;
    email: string;
    full_name: string;
    role: ServerRole;
    created_at: string;
  }>(
    `
      SELECT u.id, u.email, u.full_name, m.role, u.created_at
      FROM user_accounts u
      JOIN tenant_memberships m ON m.user_id = u.id
      WHERE m.tenant_id = $1
      ORDER BY u.created_at ASC
    `,
    [tenantId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    createdAt: row.created_at,
  }));
};

export const addUserToTenant = async (
  pool: Pool,
  tenantId: string,
  input: AddTenantUserRequest,
): Promise<PlatformTenantUserSummary> => {
  return withSerializablePostgresTransaction(pool, async (client) => {
    const tenantRow = await client.query<{ id: string; product: ServerProduct }>(
      'SELECT id, product FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId],
    );
    const tenant = tenantRow.rows[0];
    if (!tenant) {
      throw new Error('Workspace not found');
    }

    const email = normalizeEmailAddress(input.email);
    const existingUser = await client.query<{ id: string }>('SELECT id FROM user_accounts WHERE lower(email) = lower($1) LIMIT 1', [email]);
    if (existingUser.rows[0]) {
      throw new Error('A user with this email already exists');
    }

    const now = new Date().toISOString();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const salt = createSalt();
    const dependencies = createPostgresBillingDependencies(client);
    const scope = { tenantId: tenant.id, product: tenant.product, deploymentMode: 'multi-tenant' as const };
    await dependencies.userRepo.save(scope, {
      id: userId,
      email,
      fullName: input.fullName.trim(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await dependencies.membershipRepo.save(scope, {
      id: membershipId,
      tenantId: tenant.id,
      userId,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    });
    await client.query(
      `
        INSERT INTO user_password_credentials (
          user_id, password_salt, password_hash, password_algorithm, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6
        )
      `,
    [userId, salt, await derivePasswordHash(input.password, salt), 'scrypt-64', now, now],
    );

    return {
      id: userId,
      email,
      fullName: input.fullName.trim(),
      role: input.role,
      createdAt: now,
    };
  });
};

export const createPostgresAuthStore = (pool: Pool): ServerAuthStore => ({
  async getBootstrapStatus(product) {
    const result = await pool.query<{ count: string }>(
      `
        SELECT COUNT(DISTINCT u.id)::text AS count
        FROM user_accounts u
        JOIN tenant_memberships m ON m.user_id = u.id
        JOIN tenants t ON t.id = m.tenant_id
        WHERE t.product = $1
      `,
      [product],
    );
    const userCount = Number(result.rows[0]?.count ?? 0);
    return {
      bootstrapped: userCount > 0,
      userCount,
    };
  },

  async bootstrap(product, input) {
    return withSerializablePostgresTransaction(pool, async (client) => {
      const existingTenant = await client.query<{ id: string }>('SELECT id FROM tenants WHERE product = $1 LIMIT 1', [product]);
      if (existingTenant.rows[0]) {
        throw new Error(`Bootstrap already completed for ${product}`);
      }

      const tenant = createTenantSeed(product);
      return provisionTenantWithOwner(client, tenant, {
        email: input.email,
        fullName: input.fullName,
        password: input.password,
      });
    });
  },

  async login(product, input) {
    const email = normalizeEmailAddress(input.email);
    const result = await pool.query<{
      tenant_id: string;
      id: string;
      email: string;
      full_name: string;
      role: 'owner' | 'admin' | 'accountant' | 'sales' | 'viewer';
      password_salt: string;
      password_hash: string;
    }>(
      `
        SELECT
          m.tenant_id,
          u.id,
          u.email,
          u.full_name,
          m.role,
          c.password_salt,
          c.password_hash
        FROM user_accounts u
        JOIN user_password_credentials c ON c.user_id = u.id
        JOIN tenant_memberships m ON m.user_id = u.id
        JOIN tenants t ON t.id = m.tenant_id
        WHERE lower(u.email) = lower($1)
          AND t.product = $2
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at ASC
        LIMIT 1
      `,
      [email, product],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Invalid email or password');
    }

    const candidateHash = await derivePasswordHash(input.password, row.password_salt);
    if (candidateHash !== row.password_hash) {
      throw new Error('Invalid email or password');
    }

    await pool.query('UPDATE user_accounts SET last_login_at = $1 WHERE id = $2', [new Date().toISOString(), row.id]);

    return toAuthResponse(row.tenant_id, product, {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
    });
  },
});
