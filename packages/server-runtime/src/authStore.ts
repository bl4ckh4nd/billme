import { randomUUID, scryptSync } from 'crypto';
import {
  normalizeEmailAddress,
  type BootstrapStatus,
  type AuthUser,
  type BootstrapRequest,
  type LoginRequest,
  type ServerProduct,
  type ServerRole,
} from '@billme/server-core';
import { createPostgresAuthStore, createPostgresPool } from '@billme/server-data';

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

const derivePasswordHash = (password: string, salt: string): string => {
  return scryptSync(password, salt, 64).toString('hex');
};

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

  bootstrap(product: ServerProduct, input: BootstrapRequest): AuthenticatedPrincipal {
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
      passwordHash: derivePasswordHash(input.password, salt),
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

  login(product: ServerProduct, input: LoginRequest): AuthenticatedPrincipal {
    const users = this.usersByProduct.get(product);
    const email = normalizeEmailAddress(input.email);
    const user = users?.get(email);
    if (!user) {
      throw new Error('Invalid email or password');
    }

    const candidateHash = derivePasswordHash(input.password, user.salt);
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
