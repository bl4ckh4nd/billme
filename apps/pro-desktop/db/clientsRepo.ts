import type Database from 'better-sqlite3';
import {
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  normalizeClientAddresses,
  normalizeClientEmails,
  prepareClientForUpsert,
} from '@billme/server-core/services';
import type { Activity, Client, ClientAddress, ClientEmail, Project } from '../types';
import { formatAddressMultiline } from '../utils/formatters';
import { ensureDefaultProjectForClient } from './projectsRepo';
import { safeJsonParse, TagsSchema } from './validation-schemas';
import { finalizeNumber, reserveNumber } from './numberingRepo';

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
  const clients = db.prepare('SELECT * FROM clients ORDER BY company ASC').all() as ClientRow[];
  const projects = db
    .prepare('SELECT * FROM client_projects ORDER BY client_id, start_date DESC')
    .all() as ProjectRow[];
  const activities = db
    .prepare('SELECT * FROM client_activities ORDER BY client_id, date DESC')
    .all() as ActivityRow[];
  const addressRows = db
    .prepare('SELECT * FROM client_addresses ORDER BY client_id, is_default_billing DESC, label ASC')
    .all() as ClientAddressRow[];
  const emailRows = db
    .prepare('SELECT * FROM client_emails ORDER BY client_id, is_default_billing DESC, label ASC')
    .all() as ClientEmailRow[];

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
    const exists = db.prepare('SELECT id, customer_number FROM clients WHERE id = ?').get(client.id) as
      | { id: string; customer_number: string | null }
      | undefined;
    const existingCustomerNumber = exists?.customer_number?.trim() ?? '';

    const prepared = prepareClientForUpsert(client, {
      existingCustomerNumber,
      customerNumberExists: (customerNumber: string) => {
        const conflictingCustomerNumber = db
          .prepare('SELECT id FROM clients WHERE customer_number = ? AND id <> ? LIMIT 1')
          .get(customerNumber, client.id) as { id: string } | undefined;
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
      db.prepare(
        `
          INSERT INTO clients (
            id, customer_number, company, contact_person, email, phone, address, status, avatar, tags_json, notes
          ) VALUES (
            @id, @customerNumber, @company, @contactPerson, @email, @phone, @address, @status, @avatar, @tagsJson, @notes
          )
        `,
      ).run({
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
      });
    } else {
      db.prepare(
        `
          UPDATE clients SET
            customer_number=@customerNumber,
            company=@company,
            contact_person=@contactPerson,
            email=@email,
            phone=@phone,
            address=@address,
            status=@status,
            avatar=@avatar,
            tags_json=@tagsJson,
            notes=@notes
          WHERE id=@id
        `,
      ).run({
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
      });
    }

    // Replace addresses/emails for now (simple UX). Future: add partial CRUD endpoints.
    db.prepare('DELETE FROM client_addresses WHERE client_id = ?').run(client.id);
    const insertAddress = db.prepare(
      `
        INSERT INTO client_addresses (
          id, client_id, label, kind, company, contact_person, street, line2, zip, city, country,
          is_default_billing, is_default_shipping, created_at, updated_at
        ) VALUES (
          @id, @clientId, @label, @kind, @company, @contactPerson, @street, @line2, @zip, @city, @country,
          @isDefaultBilling, @isDefaultShipping, @createdAt, @updatedAt
        )
      `,
    );
    const now = new Date().toISOString();
    let seenBilling = false;
    let seenShipping = false;
    for (const a of addresses) {
      const isDefaultBilling = Boolean(a.isDefaultBilling) && !seenBilling;
      const isDefaultShipping = Boolean(a.isDefaultShipping) && !seenShipping;
      if (isDefaultBilling) seenBilling = true;
      if (isDefaultShipping) seenShipping = true;
      insertAddress.run({
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
      });
    }
    if (!seenBilling && addresses.length > 0) {
      db.prepare('UPDATE client_addresses SET is_default_billing = 1 WHERE id = ?').run(addresses[0].id);
    }
    if (!seenShipping && addresses.length > 0) {
      db.prepare('UPDATE client_addresses SET is_default_shipping = 1 WHERE id = ?').run(addresses[0].id);
    }

    db.prepare('DELETE FROM client_emails WHERE client_id = ?').run(client.id);
    const insertEmail = db.prepare(
      `
        INSERT INTO client_emails (
          id, client_id, label, kind, email, is_default_general, is_default_billing, created_at, updated_at
        ) VALUES (
          @id, @clientId, @label, @kind, @email, @isDefaultGeneral, @isDefaultBilling, @createdAt, @updatedAt
        )
      `,
    );
    let seenBillingEmail = false;
    let seenGeneralEmail = false;
    for (const e of emails) {
      const isDefaultBilling = Boolean(e.isDefaultBilling) && !seenBillingEmail;
      const isDefaultGeneral = Boolean(e.isDefaultGeneral) && !seenGeneralEmail;
      if (isDefaultBilling) seenBillingEmail = true;
      if (isDefaultGeneral) seenGeneralEmail = true;
      insertEmail.run({
        id: e.id,
        clientId: client.id,
        label: e.label,
        kind: e.kind,
        email: e.email,
        isDefaultGeneral: isDefaultGeneral ? 1 : 0,
        isDefaultBilling: isDefaultBilling ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (!seenBillingEmail && emails.length > 0) {
      db.prepare('UPDATE client_emails SET is_default_billing = 1 WHERE id = ?').run(emails[0].id);
    }
    if (!seenGeneralEmail && emails.length > 0) {
      db.prepare('UPDATE client_emails SET is_default_general = 1 WHERE id = ?').run(emails[0].id);
    }

    // Projects and activities are managed via their own flows and should not be
    // implicitly overwritten from the client edit form.
    ensureDefaultProjectForClient(db, client.id);
    if (customerReservationId) {
      finalizeNumber(db, customerReservationId, client.id);
    }

    // Keep client_number in sync on all existing documents for this client.
    db.prepare('UPDATE invoices SET client_number = ? WHERE client_id = ?').run(customerNumber, client.id);
    db.prepare('UPDATE offers SET client_number = ? WHERE client_id = ?').run(customerNumber, client.id);

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
    db.prepare('DELETE FROM client_projects WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM client_activities WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  });

  tx();
};
