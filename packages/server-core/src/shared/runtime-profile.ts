import { z } from 'zod';

export const serverProductValues = ['lite', 'pro'] as const;
export const serverRoleValues = ['owner', 'admin', 'accountant', 'sales', 'viewer'] as const;
export const deploymentModeValues = ['single-tenant', 'multi-tenant'] as const;

export const serverProductSchema = z.enum(serverProductValues);
export type ServerProduct = z.infer<typeof serverProductSchema>;

export const serverRoleSchema = z.enum(serverRoleValues);
export type ServerRole = z.infer<typeof serverRoleSchema>;

export const deploymentModeSchema = z.enum(deploymentModeValues);
export type DeploymentMode = z.infer<typeof deploymentModeSchema>;

export const supportedServerRoles = serverRoleSchema.options;
export const supportedServerProducts = serverProductSchema.options;
