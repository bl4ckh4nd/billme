import { UiPermissionContext, User, UserRole } from '../types';

export const mockUsers: User[] = [
  { id: 'u1', name: 'Mara Buchhaltung', role: 'bookkeeper' },
  { id: 'u2', name: 'Rene Review', role: 'reviewer' },
  { id: 'u3', name: 'Anja Accountant', role: 'accountant' },
  { id: 'u4', name: 'Admin Ops', role: 'admin' },
];

export function getUserByRole(role: UserRole): User {
  return mockUsers.find((user) => user.role === role) ?? mockUsers[0];
}

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
