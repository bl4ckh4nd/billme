import type { ServerRole } from '@billme/server-core';
import { ApiError } from './http.js';

export const tenantCapabilities = [
  'clients:write',
  'documents:invoice:write',
  'documents:offer:write',
  'recurring:write',
  'numbers:write',
  'settings:write',
  'templates:write',
  'articles:write',
  'accounts:write',
  'accounting:write',
  'delete',
] as const;

export type TenantCapability = (typeof tenantCapabilities)[number];

const hasTenantCapability = (role: ServerRole, capability: TenantCapability): boolean => {
  if (role === 'owner' || role === 'admin') {
    return true;
  }

  if (role === 'accountant') {
    return [
      'documents:invoice:write',
      'recurring:write',
      'numbers:write',
      'accounts:write',
      'accounting:write',
    ].includes(capability);
  }

  return role === 'sales' && ['clients:write', 'documents:offer:write', 'articles:write'].includes(capability);
};

export const assertTenantCapability = (role: ServerRole, capability: TenantCapability): void => {
  if (!hasTenantCapability(role, capability)) {
    throw new ApiError(403, 'Role is not authorized for this operation');
  }
};
