import { randomUUID, scryptSync } from "node:crypto";
import type { Pool } from "pg";
import { and, eq, ilike } from "drizzle-orm";
import { createDrizzle, schema } from "./drizzle.js";
import {
  normalizeEmailAddress,
  type AuthUser,
  type BootstrapRequest,
  type BootstrapStatus,
  type LoginRequest,
  type ServerProduct,
  type ServerRole,
  type UserAccount,
} from "@billme/server-core";
import { withSerializablePostgresTransaction } from "./connection.js";
import { createPostgresBillingDependencies } from "./billing.js";

export interface ServerAuthStore {
  getBootstrapStatus(product: ServerProduct): Promise<BootstrapStatus>;
  bootstrap(
    product: ServerProduct,
    input: BootstrapRequest,
  ): Promise<{
    tenantId: string;
    product: ServerProduct;
    role: ServerRole;
    user: AuthUser;
  }>;
  login(
    product: ServerProduct,
    input: LoginRequest,
  ): Promise<{
    tenantId: string;
    product: ServerProduct;
    role: ServerRole;
    user: AuthUser;
  }>;
}

const derivePasswordHash = (password: string, salt: string): string => {
  return scryptSync(password, salt, 64).toString("hex");
};

const createSalt = (): string => randomUUID().replaceAll("-", "");

const createTenantSeed = (product: ServerProduct) => {
  const suffix = product === "pro" ? "pro" : "lite";
  const label = product === "pro" ? "Billme Pro" : "Billme";
  return {
    id: randomUUID(),
    slug: `${suffix}-primary`,
    displayName: label,
    product,
    deploymentMode: "single-tenant" as const,
    status: "active" as const,
  };
};

const toAuthResponse = (
  tenantId: string,
  product: ServerProduct,
  user: Pick<UserAccount, "id" | "email" | "fullName"> & {
    role: "owner" | "admin" | "accountant" | "sales" | "viewer";
  },
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

export const createPostgresAuthStore = (pool: Pool): ServerAuthStore => ({
  async getBootstrapStatus(product) {
    const db = createDrizzle(pool);
    const rows = await db
      .select({ id: schema.userAccounts.id })
      .from(schema.userAccounts)
      .innerJoin(
        schema.tenantMemberships,
        eq(schema.userAccounts.id, schema.tenantMemberships.userId),
      )
      .innerJoin(
        schema.tenants,
        eq(schema.tenants.id, schema.tenantMemberships.tenantId),
      )
      .where(eq(schema.tenants.product, product));
    const userCount = new Set(rows.map((row) => row.id)).size;
    return {
      bootstrapped: userCount > 0,
      userCount,
    };
  },

  async bootstrap(product, input) {
    return withSerializablePostgresTransaction(pool, async (client) => {
      const db = createDrizzle(client);
      const existingTenant = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(eq(schema.tenants.product, product))
        .limit(1);
      if (existingTenant[0]) {
        throw new Error(`Bootstrap already completed for ${product}`);
      }

      const email = normalizeEmailAddress(input.email);
      const existingUser = await db
        .select({ id: schema.userAccounts.id })
        .from(schema.userAccounts)
        .where(ilike(schema.userAccounts.email, email))
        .limit(1);
      if (existingUser[0]) {
        throw new Error("A user with this email already exists");
      }

      const now = new Date().toISOString();
      const tenant = createTenantSeed(product);
      const userId = randomUUID();
      const membershipId = randomUUID();
      const salt = createSalt();
      const dependencies = createPostgresBillingDependencies(client);
      const scope = {
        tenantId: tenant.id,
        product,
        deploymentMode: "single-tenant" as const,
      };
      await dependencies.tenantRepo.save({
        ...tenant,
        createdAt: now,
        updatedAt: now,
      });
      await dependencies.userRepo.save(scope, {
        id: userId,
        email,
        fullName: input.fullName.trim(),
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await dependencies.membershipRepo.save(
        { tenantId: tenant.id, product, deploymentMode: "single-tenant" },
        {
          id: membershipId,
          tenantId: tenant.id,
          userId,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        },
      );
      await db.insert(schema.userPasswordCredentials).values({
        userId,
        passwordSalt: salt,
        passwordHash: derivePasswordHash(input.password, salt),
        passwordAlgorithm: "scrypt-64",
        createdAt: now,
        updatedAt: now,
      });

      return toAuthResponse(tenant.id, product, {
        id: userId,
        email,
        fullName: input.fullName.trim(),
        role: "owner",
      });
    });
  },

  async login(product, input) {
    const email = normalizeEmailAddress(input.email);
    const db = createDrizzle(pool);
    const rows = await db
      .select({
        tenantId: schema.tenantMemberships.tenantId,
        id: schema.userAccounts.id,
        email: schema.userAccounts.email,
        fullName: schema.userAccounts.fullName,
        role: schema.tenantMemberships.role,
        passwordSalt: schema.userPasswordCredentials.passwordSalt,
        passwordHash: schema.userPasswordCredentials.passwordHash,
        createdAt: schema.tenantMemberships.createdAt,
      })
      .from(schema.userAccounts)
      .innerJoin(
        schema.userPasswordCredentials,
        eq(schema.userPasswordCredentials.userId, schema.userAccounts.id),
      )
      .innerJoin(
        schema.tenantMemberships,
        eq(schema.tenantMemberships.userId, schema.userAccounts.id),
      )
      .innerJoin(
        schema.tenants,
        eq(schema.tenants.id, schema.tenantMemberships.tenantId),
      )
      .where(
        and(
          ilike(schema.userAccounts.email, email),
          eq(schema.tenants.product, product),
        ),
      );
    rows.sort((a, b) => {
      const rank = (role: string | null) =>
        role === "owner" ? 0 : role === "admin" ? 1 : 2;
      return (
        rank(a.role) - rank(b.role) ||
        String(a.createdAt).localeCompare(String(b.createdAt))
      );
    });

    const row = rows[0];
    if (!row) {
      throw new Error("Invalid email or password");
    }

    const candidateHash = derivePasswordHash(input.password, row.passwordSalt!);
    if (candidateHash !== row.passwordHash) {
      throw new Error("Invalid email or password");
    }

    await db
      .update(schema.userAccounts)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(schema.userAccounts.id, row.id!));

    return toAuthResponse(row.tenantId!, product, {
      id: row.id!,
      email: row.email!,
      fullName: row.fullName!,
      role: row.role as "owner" | "admin" | "accountant" | "sales" | "viewer",
    });
  },
});
