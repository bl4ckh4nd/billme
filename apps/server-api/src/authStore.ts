import { randomUUID, scrypt } from 'crypto';
import { promisify } from 'node:util';
import {
  normalizeEmailAddress,
  type AddTenantUserRequest,
  type BootstrapStatus,
  type AuthUser,
  type BootstrapRequest,
  type CreateWorkspaceRequest,
  type LoginRequest,
  type PlatformTenantSummary,
  type PlatformTenantUserSummary,
  type ServerProduct,
  type ServerRole,
} from '@billme/server-core';
import {
  addUserToTenant,
  createPostgresAuthStore,
  createPostgresPool,
  createTenantAsPlatformAdmin,
  listTenantUsers,
  listTenants,
} from '@billme/server-data';

type UserRecord = AuthUser & {
  tenantId: string;
  product: ServerProduct;
  salt: string;
  passwordHash: string;
};

export interface AuthenticatedPrincipal {
  tenantId: string;
  product: ServerProduct;
  role: ServerRole;
  user: AuthUser;
}

export interface AuthStore {
  getBootstrapStatus(product: ServerProduct): Promise<BootstrapStatus> | BootstrapStatus;
  bootstrap(product: ServerProduct, input: BootstrapRequest): Promise<AuthenticatedPrincipal> | AuthenticatedPrincipal;
  login(product: ServerProduct, input: LoginRequest): Promise<AuthenticatedPrincipal> | AuthenticatedPrincipal;
}

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keyLength: number) => Promise<Buffer>;
const derivePasswordHash = async (password: string, salt: string): Promise<string> =>
  (await scryptAsync(password, salt, 64)).toString('hex');

const createSalt = (): string => randomUUID().replaceAll('-', '');

export class InMemoryAuthStore implements AuthStore {
  private readonly usersByProduct = new Map<ServerProduct, Map<string, UserRecord>>();

  getBootstrapStatus(product: ServerProduct) {
    const users = this.usersByProduct.get(product);
    return {
      bootstrapped: (users?.size ?? 0) > 0,
      userCount: users?.size ?? 0,
    };
  }

  async bootstrap(product: ServerProduct, input: BootstrapRequest): Promise<AuthenticatedPrincipal> {
    const users = this.usersByProduct.get(product) ?? new Map<string, UserRecord>();
    if (users.size > 0) {
      throw new Error(`Bootstrap already completed for ${product}`);
    }

    const email = normalizeEmailAddress(input.email);
    if (users.has(email)) {
      throw new Error('A user with this email already exists');
    }

    const salt = createSalt();
    const tenantId = randomUUID();
    const user: UserRecord = {
      id: randomUUID(),
      tenantId,
      product,
      email,
      fullName: input.fullName.trim(),
      role: 'owner',
      salt,
      passwordHash: await derivePasswordHash(input.password, salt),
    };

    users.set(email, user);
    this.usersByProduct.set(product, users);
    return {
      tenantId,
      product,
      role: user.role,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }

  async login(product: ServerProduct, input: LoginRequest): Promise<AuthenticatedPrincipal> {
    const users = this.usersByProduct.get(product);
    const email = normalizeEmailAddress(input.email);
    const user = users?.get(email);
    if (!user) {
      throw new Error('Invalid email or password');
    }

    const candidateHash = await derivePasswordHash(input.password, user.salt);
    if (candidateHash !== user.passwordHash) {
      throw new Error('Invalid email or password');
    }

    return {
      tenantId: user.tenantId,
      product,
      role: user.role,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }

  registerTenantUser(product: ServerProduct, user: UserRecord): void {
    const users = this.usersByProduct.get(product) ?? new Map<string, UserRecord>();
    users.set(user.email, user);
    this.usersByProduct.set(product, users);
  }
}

type PoolLike = ReturnType<typeof createPostgresPool>;

export const createAuthStore = ({
  pool,
}: {
  pool?: PoolLike;
  env?: NodeJS.ProcessEnv;
} = {}): AuthStore => {
  if (!pool) {
    return new InMemoryAuthStore();
  }
  return createPostgresAuthStore(pool);
};

export interface PlatformAuthStore {
  listTenants(): Promise<PlatformTenantSummary[]> | PlatformTenantSummary[];
  createTenant(input: CreateWorkspaceRequest): Promise<PlatformTenantSummary> | PlatformTenantSummary;
  listTenantUsers(tenantId: string): Promise<PlatformTenantUserSummary[]> | PlatformTenantUserSummary[];
  addTenantUser(
    tenantId: string,
    input: AddTenantUserRequest,
  ): Promise<PlatformTenantUserSummary> | PlatformTenantUserSummary;
}

interface InMemoryTenantRecord extends PlatformTenantSummary {
  users: Map<string, UserRecord & { role: ServerRole }>;
}

export class InMemoryPlatformAuthStore implements PlatformAuthStore {
  constructor(private readonly authStore: InMemoryAuthStore) {}

  private readonly tenants = new Map<string, InMemoryTenantRecord>();

  listTenants(): PlatformTenantSummary[] {
    return Array.from(this.tenants.values()).map(({ users, ...summary }) => summary);
  }

  async createTenant(input: CreateWorkspaceRequest): Promise<PlatformTenantSummary> {
    const existingSlug = Array.from(this.tenants.values()).find((tenant) => tenant.slug === input.slug);
    if (existingSlug) {
      throw new Error(`A workspace with slug "${input.slug}" already exists`);
    }

    const tenantId = randomUUID();
    const email = normalizeEmailAddress(input.ownerEmail);
    const salt = createSalt();
    const now = new Date().toISOString();
    const owner: UserRecord & { role: ServerRole } = {
      id: randomUUID(),
      tenantId,
      product: input.product,
      email,
      fullName: input.ownerFullName.trim(),
      role: 'owner',
      salt,
      passwordHash: await derivePasswordHash(input.ownerPassword, salt),
    };

    const record: InMemoryTenantRecord = {
      id: tenantId,
      slug: input.slug,
      displayName: input.displayName,
      product: input.product,
      status: 'active',
      memberCount: 1,
      createdAt: now,
      users: new Map([[email, owner]]),
    };
    this.tenants.set(tenantId, record);
    this.authStore.registerTenantUser(record.product, owner);

    return {
      id: record.id,
      slug: record.slug,
      displayName: record.displayName,
      product: record.product,
      status: record.status,
      memberCount: record.memberCount,
      createdAt: record.createdAt,
    };
  }

  listTenantUsers(tenantId: string): PlatformTenantUserSummary[] {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new Error('Workspace not found');
    }
    return Array.from(tenant.users.values()).map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      createdAt: new Date().toISOString(),
    }));
  }

  async addTenantUser(tenantId: string, input: AddTenantUserRequest): Promise<PlatformTenantUserSummary> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new Error('Workspace not found');
    }
    const email = normalizeEmailAddress(input.email);
    if (tenant.users.has(email)) {
      throw new Error('A user with this email already exists');
    }

    const salt = createSalt();
    const user: UserRecord & { role: ServerRole } = {
      id: randomUUID(),
      tenantId,
      product: tenant.product,
      email,
      fullName: input.fullName.trim(),
      role: input.role,
      salt,
      passwordHash: await derivePasswordHash(input.password, salt),
    };
    tenant.users.set(email, user);
    tenant.memberCount += 1;
    this.authStore.registerTenantUser(tenant.product, user);

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      createdAt: new Date().toISOString(),
    };
  }
}

export const createPlatformAuthStore = ({
  pool,
  authStore,
}: {
  pool?: PoolLike;
  authStore: AuthStore;
}): PlatformAuthStore => {
  if (!pool) {
    if (!(authStore instanceof InMemoryAuthStore)) {
      throw new Error('In-memory platform auth store requires an in-memory auth store');
    }
    return new InMemoryPlatformAuthStore(authStore);
  }
  return {
    listTenants: () => listTenants(pool),
    createTenant: (input) => createTenantAsPlatformAdmin(pool, input),
    listTenantUsers: (tenantId) => listTenantUsers(pool, tenantId),
    addTenantUser: (tenantId, input) => addUserToTenant(pool, tenantId, input),
  };
};
