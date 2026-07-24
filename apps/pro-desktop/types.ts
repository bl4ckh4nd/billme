import type { Account as BaseAccount } from '@billme/desktop-core/types';

export * from '@billme/desktop-core/types';

export interface Account extends BaseAccount {
  defaultSkrAccountNumber: string;
}
