import type Database from 'better-sqlite3';
import { asc, desc, eq, and, ne } from 'drizzle-orm';
import {
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  normalizeClientAddresses,
  normalizeClientEmails,
  prepareClientForUpsert,
} from '@billme/server-core/services';
import type { Activity, Client, ClientAddress, ClientEmail, Project } from '@billme/desktop-core/types';
import { formatAddressMultiline } from '@billme/desktop-utils/formatters';
import { ensureDefaultProjectForClient } from './projectsRepo';
import { safeJsonParse, TagsSchema } from './validation-schemas';
import { finalizeNumber, reserveNumber } from './numberingRepo';
import { createDrizzle, schema } from './drizzle';

type ClientRow = {
  id: string;
  customer_number: string | null;
  company: string;
  contact_person: string;
  email: string;
  phone: string;
  address: string;
  status: string;
  avatar: string | null;
  tags_json: string;
  notes: string;
  tax_profile_json: string | null;
};

const parseTaxProfile = (value: string | null): Client['taxProfile'] | undefined => {
  if (!value) return undefined;
  try { return JSON.parse(value) as Client['taxProfile']; } catch { return undefined; }
};

type ClientAddressRow = {
  id: string;
  client_id: string;
  label: string;
  kind: string;
  company: string | null;
  contact_person: string | null;
  street: string;
  line2: string | null;
  zip: string;
  city: string;
  country: string;
  is_default_billing: number;
  is_default_shipping: number;
};

type ClientEmailRow = {
  id: string;
  client_id: string;
  label: string;
  kind: string;
  email: string;
  is_default_general: number;
  is_default_billing: number;
};

type ProjectRow = {
  id: string;
  client_id: string;
  code: string | null;
  name: string;
  status: string;
  budget: number;
  start_date: string;
  end_date: string | null;
  description: string | null;
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ActivityRow = {
  id: string;
  client_id: string;
  type: string;
  content: string;
  date: string;
  author: string;
};

export const listClients = (db: Database.Database): Client[] => {
  const drizzle = createDrizzle(db);
  const clients = drizzle.select({
    id: schema.clients.id,
    customer_number: schema.clients.customerNumber,
    company: schema.clients.company,
    contact_person: schema.clients.contactPerson,
    email: schema.clients.email,
    phone: schema.clients.phone,
    address: schema.clients.address,
    status: schema.clients.status,
    avatar: schema.clients.avatar,
    tags_json: schema.clients.tagsJson,
    notes: schema.clients.notes,
    tax_profile_json: schema.clients.taxProfileJson,
  }).from(schema.clients).orderBy(asc(schema.clients.company)).all() as ClientRow[];
  const projects = drizzle.select({
    id: schema.clientProjects.id,
    client_id: schema.clientProjects.clientId,
    code: schema.clientProjects.code,
    name: schema.clientProjects.name,
    status: schema.clientProjects.status,
    budget: schema.clientProjects.budget,
    start_date: schema.clientProjects.startDate,
    end_date: schema.clientProjects.endDate,
    description: schema.clientProjects.description,
    archived_at: schema.clientProjects.archivedAt,
    created_at: schema.clientProjects.createdAt,
    updated_at: schema.clientProjects.updatedAt,
  }).from(schema.clientProjects).orderBy(asc(schema.clientProjects.clientId), desc(schema.clientProjects.startDate)).all() as ProjectRow[];
  const activities = drizzle.select({
    id: schema.clientActivities.id,
    client_id: schema.clientActivities.clientId,
    type: schema.clientActivities.type,
    content: schema.clientActivities.content,
    date: schema.clientActivities.date,
    author: schema.clientActivities.author,
  }).from(schema.clientActivities).orderBy(asc(schema.clientActivities.clientId), desc(schema.clientActivities.date)).all() as ActivityRow[];
  const addressRows = drizzle.select({
    id: schema.clientAddresses.id,
    client_id: schema.clientAddresses.clientId,
    label: schema.clientAddresses.label,
    kind: schema.clientAddresses.kind,
    company: schema.clientAddresses.company,
    contact_person: schema.clientAddresses.contactPerson,
    street: schema.clientAddresses.street,
    line2: schema.clientAddresses.line2,
    zip: schema.clientAddresses.zip,
    city: schema.clientAddresses.city,
    country: schema.clientAddresses.country,
    is_default_billing: schema.clientAddresses.isDefaultBilling,
    is_default_shipping: schema.clientAddresses.isDefaultShipping,
  }).from(schema.clientAddresses).orderBy(asc(schema.clientAddresses.clientId), desc(schema.clientAddresses.isDefaultBilling), asc(schema.clientAddresses.label)).all() as ClientAddressRow[];
  const emailRows = drizzle.select({
    id: schema.clientEmails.id,
    client_id: schema.clientEmails.clientId,
    label: schema.clientEmails.label,
    kind: schema.clientEmails.kind,
    email: schema.clientEmails.email,
    is_default_general: schema.clientEmails.isDefaultGeneral,
    is_default_billing: schema.clientEmails.isDefaultBilling,
  }).from(schema.clientEmails).orderBy(asc(schema.clientEmails.clientId), desc(schema.clientEmails.isDefaultBilling), asc(schema.clientEmails.label)).all() as ClientEmailRow[];

  const projectsByClient = new Map<string, Project[]>();
  for (const p of projects) {
    const list = projectsByClient.get(p.client_id) ?? [];
    list.push({
      id: p.id,
      clientId: p.client_id,
      code: p.code ?? undefined,
      name: p.name,
      status: p.status as 'active' | 'archived' | 'inactive',
      budget: p.budget,
      startDate: p.start_date,
      endDate: p.end_date ?? undefined,
      description: p.description ?? undefined,
      archivedAt: p.archived_at ?? undefined,
      createdAt: p.created_at ?? undefined,
      updatedAt: p.updated_at ?? undefined,
    });
    projectsByClient.set(p.client_id, list);
  }

  const activitiesByClient = new Map<string, Activity[]>();
  for (const a of activities) {
    const list = activitiesByClient.get(a.client_id) ?? [];
    list.push({
      id: a.id,
      type: a.type as 'call' | 'email' | 'meeting' | 'note',
      content: a.content,
      date: a.date,
      author: a.author,
    });
    activitiesByClient.set(a.client_id, list);
  }

  const addressesByClient = new Map<string, ClientAddress[]>();
  for (const r of addressRows) {
    const list = addressesByClient.get(r.client_id) ?? [];
    list.push({
      id: r.id,
      clientId: r.client_id,
      label: r.label,
      kind: (r.kind as 'billing' | 'shipping' | 'other') ?? 'other',
      company: r.company ?? undefined,
      contactPerson: r.contact_person ?? undefined,
      street: r.street,
      line2: r.line2 ?? undefined,
      zip: r.zip,
      city: r.city,
      country: r.country,
      isDefaultBilling: Boolean(r.is_default_billing),
      isDefaultShipping: Boolean(r.is_default_shipping),
    });
    addressesByClient.set(r.client_id, list);
  }

  const emailsByClient = new Map<string, ClientEmail[]>();
  for (const r of emailRows) {
    const list = emailsByClient.get(r.client_id) ?? [];
    list.push({
      id: r.id,
      clientId: r.client_id,
      label: r.label,
      kind: (r.kind as 'billing' | 'shipping' | 'other') ?? 'other',
      email: r.email,
      isDefaultGeneral: Boolean(r.is_default_general),
      isDefaultBilling: Boolean(r.is_default_billing),
    });
    emailsByClient.set(r.client_id, list);
  }

  return clients.map((c) => {
    const baseClient: Client = {
      id: c.id,
      customerNumber: c.customer_number ?? undefined,
      company: c.company,
      contactPerson: c.contact_person,
      email: c.email,
      phone: c.phone,
      address: c.address,
      status: c.status as 'active' | 'inactive',
      avatar: c.avatar ?? undefined,
      tags: safeJsonParse(c.tags_json, TagsSchema, [], `Client ${c.id} tags`),
      notes: c.notes,
      taxProfile: parseTaxProfile(c.tax_profile_json),
      projects: projectsByClient.get(c.id) ?? [],
      activities: activitiesByClient.get(c.id) ?? [],
      addresses: addressesByClient.get(c.id) ?? [],
      emails: emailsByClient.get(c.id) ?? [],
    };

    // Backward-compatible default fields.
    const addresses = normalizeClientAddresses(baseClient) as ClientAddress[];
    const emails = normalizeClientEmails(baseClient) as ClientEmail[];
    const billingAddress = chooseDefaultBillingAddress(addresses);
    const billingEmail = chooseDefaultBillingEmail(emails);

    return {
      ...baseClient,
      addresses,
      emails,
      address: billingAddress ? formatAddressMultiline(billingAddress) : baseClient.address,
      email: billingEmail?.email ?? baseClient.email,
    };
  });
};

export const getClient = (db: Database.Database, id: string): Client | null => {
  const all = listClients(db);
  return all.find((c) => c.id === id) ?? null;
};

export const upsertClient = (db: Database.Database, client: Client): Client => {
  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    const exists = drizzle.select({ id: schema.clients.id, customer_number: schema.clients.customerNumber })
      .from(schema.clients).where(eq(schema.clients.id, client.id)).get() as
      | { id: string; customer_number: string | null }
      | undefined;
    const existingCustomerNumber = exists?.customer_number?.trim() ?? '';

    const prepared = prepareClientForUpsert(client, {
      existingCustomerNumber,
      customerNumberExists: (customerNumber: string) => {
        const conflictingCustomerNumber = drizzle.select({ id: schema.clients.id })
          .from(schema.clients)
          .where(and(eq(schema.clients.customerNumber, customerNumber), ne(schema.clients.id, client.id)))
          .limit(1).get() as { id: string } | undefined;
        return Boolean(conflictingCustomerNumber);
      },
      reserveCustomerNumber: () => reserveNumber(db, 'customer'),
    });

    const addresses = prepared.addresses as ClientAddress[];
    const emails = prepared.emails as ClientEmail[];
    const legacyAddress = prepared.address;
    const legacyEmail = prepared.email;
    const customerNumber = prepared.customerNumber;
    const customerReservationId = prepared.customerNumberReservationId;

    if (!exists) {
      drizzle.insert(schema.clients).values({
        id: client.id,
        customerNumber,
        company: client.company,
        contactPerson: client.contactPerson,
        email: legacyEmail,
        phone: client.phone,
        address: legacyAddress,
        status: client.status,
        avatar: client.avatar ?? null,
        tagsJson: JSON.stringify(client.tags ?? []),
        notes: client.notes ?? '',
        taxProfileJson: client.taxProfile ? JSON.stringify(client.taxProfile) : null,
      }).run();
    } else {
      drizzle.update(schema.clients).set({
        customerNumber,
        company: client.company,
        contactPerson: client.contactPerson,
        email: legacyEmail,
        phone: client.phone,
        address: legacyAddress,
        status: client.status,
        avatar: client.avatar ?? null,
        tagsJson: JSON.stringify(client.tags ?? []),
        notes: client.notes ?? '',
        taxProfileJson: client.taxProfile ? JSON.stringify(client.taxProfile) : null,
      }).where(eq(schema.clients.id, client.id)).run();
    }

    // Replace addresses/emails for now (simple UX). Future: add partial CRUD endpoints.
    drizzle.delete(schema.clientAddresses).where(eq(schema.clientAddresses.clientId, client.id)).run();
    const now = new Date().toISOString();
    let seenBilling = false;
    let seenShipping = false;
    for (const a of addresses) {
      const isDefaultBilling = Boolean(a.isDefaultBilling) && !seenBilling;
      const isDefaultShipping = Boolean(a.isDefaultShipping) && !seenShipping;
      if (isDefaultBilling) seenBilling = true;
      if (isDefaultShipping) seenShipping = true;
      drizzle.insert(schema.clientAddresses).values({
        id: a.id,
        clientId: client.id,
        label: a.label,
        kind: a.kind,
        company: a.company ?? null,
        contactPerson: a.contactPerson ?? null,
        street: a.street,
        line2: a.line2 ?? null,
        zip: a.zip,
        city: a.city,
        country: a.country || 'DE',
        isDefaultBilling: isDefaultBilling ? 1 : 0,
        isDefaultShipping: isDefaultShipping ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    if (!seenBilling && addresses.length > 0) {
      drizzle.update(schema.clientAddresses).set({ isDefaultBilling: 1 }).where(eq(schema.clientAddresses.id, addresses[0].id)).run();
    }
    if (!seenShipping && addresses.length > 0) {
      drizzle.update(schema.clientAddresses).set({ isDefaultShipping: 1 }).where(eq(schema.clientAddresses.id, addresses[0].id)).run();
    }

    drizzle.delete(schema.clientEmails).where(eq(schema.clientEmails.clientId, client.id)).run();
    let seenBillingEmail = false;
    let seenGeneralEmail = false;
    for (const e of emails) {
      const isDefaultBilling = Boolean(e.isDefaultBilling) && !seenBillingEmail;
      const isDefaultGeneral = Boolean(e.isDefaultGeneral) && !seenGeneralEmail;
      if (isDefaultBilling) seenBillingEmail = true;
      if (isDefaultGeneral) seenGeneralEmail = true;
      drizzle.insert(schema.clientEmails).values({
        id: e.id,
        clientId: client.id,
        label: e.label,
        kind: e.kind,
        email: e.email,
        isDefaultGeneral: isDefaultGeneral ? 1 : 0,
        isDefaultBilling: isDefaultBilling ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    if (!seenBillingEmail && emails.length > 0) {
      drizzle.update(schema.clientEmails).set({ isDefaultBilling: 1 }).where(eq(schema.clientEmails.id, emails[0].id)).run();
    }
    if (!seenGeneralEmail && emails.length > 0) {
      drizzle.update(schema.clientEmails).set({ isDefaultGeneral: 1 }).where(eq(schema.clientEmails.id, emails[0].id)).run();
    }

    // Projects and activities are managed via their own flows and should not be
    // implicitly overwritten from the client edit form.
    ensureDefaultProjectForClient(db, client.id);
    if (customerReservationId) {
      finalizeNumber(db, customerReservationId, client.id);
    }

      return {
        ...prepared,
        customerNumber,
        email: legacyEmail,
        address: legacyAddress,
        addresses,
        emails,
    };
  });

  return tx();
};

export const deleteClient = (db: Database.Database, id: string): void => {
  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    drizzle.delete(schema.clientProjects).where(eq(schema.clientProjects.clientId, id)).run();
    drizzle.delete(schema.clientActivities).where(eq(schema.clientActivities.clientId, id)).run();
    drizzle.delete(schema.clients).where(eq(schema.clients.id, id)).run();
  });

  tx();
};
