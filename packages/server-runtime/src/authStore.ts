import { createHash, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
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
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';

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
      throw Object.assign(new Error(`Bootstrap already completed for ${product}`), { statusCode: 409 });
    }

    const email = normalizeEmailAddress(input.email);
    if (users.has(email)) {
      throw Object.assign(new Error('A user with this email already exists'), { statusCode: 409 });
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
      throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
    }

    const candidateHash = derivePasswordHash(input.password, user.salt);
    if (candidateHash !== user.passwordHash) {
      throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
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

const sameSecret = (candidate: string, expected: string): boolean =>
  timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(expected).digest());

/**
 * With a setup token configured, only someone who knows it can create the first
 * owner; without one the bootstrap stays open (local development, E2E stacks).
 */
const requireSetupToken = (store: AuthStore, setupToken: string | undefined): AuthStore => {
  if (!setupToken) return store;
  return {
    async getBootstrapStatus(product) {
      return { ...(await store.getBootstrapStatus(product)), setupTokenRequired: true };
    },
    async bootstrap(product, input) {
      if (!input.setupToken || !sameSecret(input.setupToken, setupToken)) {
        throw Object.assign(new Error('Invalid setup token'), { statusCode: 403 });
      }
      return store.bootstrap(product, input);
    },
    login: (product, input) => store.login(product, input),
  };
};

export const createAuthStore = ({
  pool,
  env = process.env,
  setupToken = env.BILLME_SETUP_TOKEN?.trim() || undefined,
}: {
  pool?: PoolLike;
  env?: NodeJS.ProcessEnv;
  setupToken?: string;
} = {}): AuthStore => {
  const store = pool
    ? createPostgresAuthStore(pool, { initialSettingsJson: JSON.stringify(DEFAULT_SETTINGS) })
    : new InMemoryAuthStore();
  return requireSetupToken(store, setupToken);
};
