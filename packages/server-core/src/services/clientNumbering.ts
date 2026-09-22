import type {
  ClientProjectShape,
  DefaultProjectPorts,
  DocumentNumberKind,
  DocumentNumberingPorts,
  MaybePromise,
  NumberingSettingsShape,
  SyncDefaultProjectPorts,
  SyncDocumentNumberingPorts,
} from '../ports/index.js';
import { chainMaybePromise } from './maybePromise.js';

export interface ClientAddressRecord {
  id: string;
  clientId: string;
  label: string;
  kind: 'billing' | 'shipping' | 'other';
  company?: string;
  contactPerson?: string;
  street: string;
  line2?: string;
  zip: string;
  city: string;
  country: string;
  isDefaultBilling?: boolean;
  isDefaultShipping?: boolean;
}

export interface ClientEmailRecord {
  id: string;
  clientId: string;
  label: string;
  kind: 'general' | 'billing' | 'shipping' | 'other';
  email: string;
  isDefaultGeneral?: boolean;
  isDefaultBilling?: boolean;
}

export interface ClientRecord {
  id: string;
  customerNumber?: string;
  company: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  status: 'active' | 'inactive';
  avatar?: string;
  tags: string[];
  notes: string;
  addresses?: ClientAddressRecord[];
  emails?: ClientEmailRecord[];
  projects: unknown[];
  activities: unknown[];
}

export type PreparedClientForUpsert<TClient extends ClientRecord = ClientRecord> = Omit<
  TClient,
  'customerNumber' | 'email' | 'address' | 'addresses' | 'emails'
> & {
  customerNumber: string;
  customerNumberReservationId: string | null;
  address: string;
  email: string;
  addresses: ClientAddressRecord[];
  emails: ClientEmailRecord[];
};

const DEFAULT_PROJECT_NAME = 'Allgemein';

function toSafeLength(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.floor(value));
}

function toSafeCounter(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function getCurrentCounter<TSettings extends NumberingSettingsShape>(settings: TSettings, kind: DocumentNumberKind): number {
  if (kind === 'invoice') return settings.numbers.nextInvoiceNumber;
  if (kind === 'offer') return settings.numbers.nextOfferNumber;
  return settings.numbers.nextCustomerNumber;
}

function setCurrentCounter<TSettings extends NumberingSettingsShape>(
  settings: TSettings,
  kind: DocumentNumberKind,
  nextValue: number,
): void {
  const safeNextValue = toSafeCounter(nextValue);
  if (kind === 'invoice') {
    settings.numbers.nextInvoiceNumber = safeNextValue;
    return;
  }
  if (kind === 'offer') {
    settings.numbers.nextOfferNumber = safeNextValue;
    return;
  }
  settings.numbers.nextCustomerNumber = safeNextValue;
}

export function formatDocumentNumber<TSettings extends NumberingSettingsShape>(
  settings: TSettings,
  kind: DocumentNumberKind,
  counterValue: number,
  now = new Date(),
): string {
  const year = String(now.getFullYear());
  let prefixTemplate = settings.numbers.customerPrefix;
  if (kind === 'invoice') {
    prefixTemplate = settings.numbers.invoicePrefix;
  } else if (kind === 'offer') {
    prefixTemplate = settings.numbers.offerPrefix;
  }

  const prefix = (prefixTemplate || '').replace(/%Y/g, year);
  const safeCounterValue = toSafeCounter(counterValue);
  const lengthSetting = kind === 'customer'
    ? settings.numbers.customerNumberLength
    : settings.numbers.numberLength;
  const length = toSafeLength(lengthSetting);
  return `${prefix}${String(safeCounterValue).padStart(length, '0')}`;
}

const createDocumentNumberReservation = <TSettings extends NumberingSettingsShape>(
  ports: DocumentNumberingPorts<TSettings>,
  settings: TSettings,
  kind: DocumentNumberKind,
  counterValue: number,
  number: string,
): MaybePromise<{ reservationId: string; number: string }> => {
  setCurrentCounter(settings, kind, counterValue + 1);
  return chainMaybePromise(ports.saveSettings(settings), () =>
    chainMaybePromise(ports.generateReservationId(), (reservationId) =>
      chainMaybePromise(
        ports.createReservation({
          id: reservationId,
          kind,
          number,
          counterValue,
          status: 'reserved',
          documentId: null,
        }),
        () => ({ reservationId, number }),
      ),
    ),
  );
};

export function reserveDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: SyncDocumentNumberingPorts<TSettings>,
  kind: DocumentNumberKind,
  now?: Date,
): { reservationId: string; number: string };
export function reserveDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: DocumentNumberingPorts<TSettings>,
  kind: DocumentNumberKind,
  now?: Date,
): MaybePromise<{ reservationId: string; number: string }>;
export function reserveDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: DocumentNumberingPorts<TSettings>,
  kind: DocumentNumberKind,
  now = new Date(),
): MaybePromise<{ reservationId: string; number: string }> {
  return ports.tx.inTransaction(() => {
    return chainMaybePromise(ports.getSettings(), (settings) => {
      if (!settings) {
        throw new Error('Settings not found');
      }

      let counterValue = toSafeCounter(getCurrentCounter(settings, kind));
      let number = formatDocumentNumber(settings, kind, counterValue, now);

      const reserveNextNumber = (): MaybePromise<{ reservationId: string; number: string }> => {
        return chainMaybePromise(ports.isNumberTaken(kind, number), (taken) => {
          if (taken) {
            counterValue += 1;
            number = formatDocumentNumber(settings, kind, counterValue, now);
            return reserveNextNumber();
          }

          return createDocumentNumberReservation(ports, settings, kind, counterValue, number);
        });
      };

      return reserveNextNumber();
    });
  });
}

export function releaseDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: SyncDocumentNumberingPorts<TSettings>,
  reservationId: string,
): { ok: true };
export function releaseDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: DocumentNumberingPorts<TSettings>,
  reservationId: string,
): MaybePromise<{ ok: true }>;
export function releaseDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: DocumentNumberingPorts<TSettings>,
  reservationId: string,
): MaybePromise<{ ok: true }> {
  return ports.tx.inTransaction(() => {
    return chainMaybePromise(ports.getReservationById(reservationId), (reservation) => {
      if (!reservation || reservation.status !== 'reserved') {
        return { ok: true } as const;
      }

      return chainMaybePromise(ports.getSettings(), (settings) => {
        if (!settings) {
          throw new Error('Settings not found');
        }

        const updateReservation = () =>
          chainMaybePromise(
            ports.updateReservation({
              ...reservation,
              status: 'released',
            }),
            () => ({ ok: true } as const),
          );

        const currentCounter = toSafeCounter(getCurrentCounter(settings, reservation.kind));
        const expectedCurrentCounter = reservation.counterValue + 1;
        if (currentCounter !== expectedCurrentCounter) {
          return updateReservation();
        }

        setCurrentCounter(settings, reservation.kind, Math.max(1, reservation.counterValue));
        return chainMaybePromise(ports.saveSettings(settings), updateReservation);
      });
    });
  });
}

export function finalizeDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: SyncDocumentNumberingPorts<TSettings>,
  reservationId: string,
  documentId: string,
): { ok: true };
export function finalizeDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: DocumentNumberingPorts<TSettings>,
  reservationId: string,
  documentId: string,
): MaybePromise<{ ok: true }>;
export function finalizeDocumentNumber<TSettings extends NumberingSettingsShape>(
  ports: DocumentNumberingPorts<TSettings>,
  reservationId: string,
  documentId: string,
): MaybePromise<{ ok: true }> {
  return ports.tx.inTransaction(() => {
    return chainMaybePromise(ports.getReservationById(reservationId), (reservation) => {
      if (!reservation) return { ok: true } as const;
      if (reservation.status === 'finalized') {
        if (reservation.documentId !== documentId) {
          throw new Error('FINALIZED_RESERVATION_DOCUMENT_MISMATCH');
        }
        return { ok: true } as const;
      }
      if (reservation.status !== 'reserved') {
        throw new Error(`Cannot finalize reservation in status "${reservation.status}"`);
      }

      return chainMaybePromise(
        ports.updateReservation({
          ...reservation,
          status: 'finalized',
          documentId,
        }),
        () => ({ ok: true } as const),
      );
    });
  });
}

export function normalizeClientAddresses(client: Pick<ClientRecord, 'id' | 'company' | 'contactPerson' | 'address' | 'addresses'>): ClientAddressRecord[] {
  const list = (client.addresses ?? []).filter(Boolean);
  if (list.length > 0) return list;

  return [
    {
      id: `addr-${client.id}-1`,
      clientId: client.id,
      label: 'Rechnungsadresse',
      kind: 'billing',
      company: client.company,
      contactPerson: client.contactPerson,
      street: client.address ?? '',
      zip: '',
      city: '',
      country: 'DE',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  ];
}

export function normalizeClientEmails(client: Pick<ClientRecord, 'id' | 'email' | 'emails'>): ClientEmailRecord[] {
  const list = (client.emails ?? []).filter(Boolean);
  if (list.length > 0) return list;

  return [
    {
      id: `email-${client.id}-1`,
      clientId: client.id,
      label: 'Buchhaltung',
      kind: 'billing',
      email: client.email ?? '',
      isDefaultGeneral: true,
      isDefaultBilling: true,
    },
  ];
}

export function chooseDefaultBillingAddress(addresses: ClientAddressRecord[]): ClientAddressRecord | null {
  if (addresses.length === 0) return null;
  return (
    addresses.find((address) => address.isDefaultBilling) ??
    addresses.find((address) => address.kind === 'billing') ??
    addresses[0] ??
    null
  );
}

export function chooseDefaultBillingEmail(emails: ClientEmailRecord[]): ClientEmailRecord | null {
  if (emails.length === 0) return null;
  return emails.find((email) => email.isDefaultBilling) ?? emails.find((email) => email.isDefaultGeneral) ?? emails[0] ?? null;
}

export function formatAddressMultiline(address: {
  company?: string;
  contactPerson?: string;
  street: string;
  line2?: string;
  zip: string;
  city: string;
  country: string;
}): string {
  const lines = [
    address.company ?? '',
    address.contactPerson ?? '',
    address.street ?? '',
    address.line2 ?? '',
    `${address.zip} ${address.city}`.trim(),
    address.country ?? '',
  ]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);
  return lines.join('\n');
}

export interface PrepareClientForUpsertOptions {
  existingCustomerNumber?: string | null;
  customerNumberExists(customerNumber: string): boolean;
  reserveCustomerNumber(): { reservationId: string; number: string };
}

export function prepareClientForUpsert<TClient extends ClientRecord>(
  client: TClient,
  options: PrepareClientForUpsertOptions,
): PreparedClientForUpsert<TClient> {
  const addresses = normalizeClientAddresses(client);
  const emails = normalizeClientEmails(client);
  const billingAddress = chooseDefaultBillingAddress(addresses);
  const billingEmail = chooseDefaultBillingEmail(emails);

  const legacyAddress = billingAddress ? formatAddressMultiline(billingAddress) : client.address;
  const legacyEmail = billingEmail?.email ?? client.email;

  let customerNumber = client.customerNumber?.trim() ?? '';
  if (!customerNumber && options.existingCustomerNumber?.trim()) {
    customerNumber = options.existingCustomerNumber.trim();
  }

  let customerNumberReservationId: string | null = null;
  if (!customerNumber) {
    const reservation = options.reserveCustomerNumber();
    customerNumber = reservation.number;
    customerNumberReservationId = reservation.reservationId;
  }

  if (options.customerNumberExists(customerNumber)) {
    throw new Error('Kundennummer bereits vergeben');
  }

  return {
    ...client,
    customerNumber,
    customerNumberReservationId,
    address: legacyAddress,
    email: legacyEmail,
    addresses,
    emails,
  } as PreparedClientForUpsert<TClient>;
}

export function buildNextProjectCode(existingCodes: Array<string | null | undefined>, year: string): string {
  let max = 0;
  for (const code of existingCodes) {
    if (!code) continue;
    const match = /^PRJ-\d{4}-(\d+)$/.exec(code);
    if (!match) continue;
    const sequence = Number(match[1] ?? '');
    if (!Number.isFinite(sequence)) continue;
    max = Math.max(max, sequence);
  }
  return `PRJ-${year}-${String(max + 1).padStart(3, '0')}`;
}

export interface EnsureDefaultProjectOptions<TProject extends ClientProjectShape> {
  clientId: string;
  createProjectId(): string;
  now?: Date;
  buildProject?(project: ClientProjectShape): TProject;
}

export function ensureDefaultProjectForClient<TProject extends ClientProjectShape>(
  ports: SyncDefaultProjectPorts<TProject>,
  options: EnsureDefaultProjectOptions<TProject>,
): { project: TProject; created: boolean };
export function ensureDefaultProjectForClient<TProject extends ClientProjectShape>(
  ports: DefaultProjectPorts<TProject>,
  options: EnsureDefaultProjectOptions<TProject>,
): MaybePromise<{ project: TProject; created: boolean }>;
export function ensureDefaultProjectForClient<TProject extends ClientProjectShape>(
  ports: DefaultProjectPorts<TProject>,
  options: EnsureDefaultProjectOptions<TProject>,
): MaybePromise<{ project: TProject; created: boolean }> {
  return ports.tx.inTransaction(() => {
    return chainMaybePromise(ports.getActiveDefaultProjectForClient(options.clientId), (existing) => {
      if (existing) {
        return { project: existing, created: false };
      }

      const now = options.now ?? new Date();
      const nowIso = now.toISOString();
      const nowDate = nowIso.split('T')[0] ?? nowIso;
      const year = String(now.getFullYear());
      const prefix = `PRJ-${year}-`;

      return chainMaybePromise(ports.listProjectCodesByPrefix(prefix), (existingCodes) => {
        const draft: ClientProjectShape = {
          id: options.createProjectId(),
          clientId: options.clientId,
          code: buildNextProjectCode(existingCodes, year),
          name: DEFAULT_PROJECT_NAME,
          status: 'active',
          budget: 0,
          startDate: nowDate,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const project = options.buildProject ? options.buildProject(draft) : draft as TProject;
        return chainMaybePromise(ports.saveProject(project), (savedProject) => ({
          project: savedProject,
          created: true,
        }));
      });
    });
  });
}
