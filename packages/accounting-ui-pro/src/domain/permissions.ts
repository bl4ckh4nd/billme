import type { UiPermissionContext, UserRole } from '../types';

export function permissionContextForRole(role: UserRole): UiPermissionContext {
  const canMutate = !['sales', 'viewer', 'auditor'].includes(role);
  return {
    role,
    canMutate,
    canApprove: canMutate && (role === 'reviewer' || role === 'accountant' || role === 'admin' || role === 'owner'),
    canPost: canMutate && (role === 'accountant' || role === 'admin' || role === 'owner'),
    canReverse: canMutate && (role === 'accountant' || role === 'admin' || role === 'owner'),
  };
}
