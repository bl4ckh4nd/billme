import type { ClientAddress, ClientEmail } from '../../types';

export const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

export const setOnlyOneFlag = <T extends { id: string }>(
    list: T[],
    id: string,
    flag: keyof T,
): T[] => list.map((x) => ({ ...x, [flag]: x.id === id }));

export const emailKindLabel: Record<ClientEmail['kind'], string> = {
    general: 'Allgemein',
    billing: 'Rechnung',
    shipping: 'Lieferung',
    other: 'Sonstiges',
};

export const addressKindLabel: Record<ClientAddress['kind'], string> = {
    billing: 'Rechnung',
    shipping: 'Lieferung',
    other: 'Sonstiges',
};

export const defaultBillingEmail = (list: ClientEmail[]) =>
    list.find((e) => e.isDefaultBilling) ?? list.find((e) => e.isDefaultGeneral) ?? list[0] ?? null;

export const defaultGeneralEmail = (list: ClientEmail[]) =>
    list.find((e) => e.isDefaultGeneral) ?? list.find((e) => e.isDefaultBilling) ?? list[0] ?? null;

export const defaultBillingAddress = (list: ClientAddress[]) =>
    list.find((a) => a.isDefaultBilling) ?? list.find((a) => a.kind === 'billing') ?? list[0] ?? null;

export const defaultShippingAddress = (list: ClientAddress[]) =>
    list.find((a) => a.isDefaultShipping) ??
    list.find((a) => a.kind === 'shipping') ??
    defaultBillingAddress(list) ??
    null;
