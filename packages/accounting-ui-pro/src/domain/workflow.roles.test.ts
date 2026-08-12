import { describe, expect, it } from 'vitest';
import { permissionContextForRole } from '../mocks/users';
import { getAllowedActions } from './workflow';

describe('server role presentation', () => {
  it.each(['viewer', 'sales'] as const)('%s has no mutation actions', (role) => {
    const permissions = permissionContextForRole(role);
    expect(permissions.canMutate).toBe(false);
    expect(getAllowedActions('ready_for_review', permissions, [])).toEqual([]);
  });

  it('owner keeps the accounting mutation capabilities', () => {
    expect(permissionContextForRole('owner')).toMatchObject({ canMutate: true, canApprove: true, canPost: true, canReverse: true });
  });
});
