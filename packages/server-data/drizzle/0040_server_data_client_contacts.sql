-- Contact persons of a client as a JSON array of {id, name, role?, email?, phone?, isPrimary}.
-- NULL on existing rows reads as no contacts; contact_person keeps the primary contact's name.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contacts_json TEXT;
