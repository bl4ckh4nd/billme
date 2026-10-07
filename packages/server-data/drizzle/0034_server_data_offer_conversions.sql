ALTER TABLE tenants ADD CONSTRAINT tenants_id_product_unique UNIQUE (id, product);
ALTER TABLE invoices ADD CONSTRAINT invoices_tenant_id_id_unique UNIQUE (tenant_id, id);
ALTER TABLE offers ADD CONSTRAINT offers_tenant_id_id_unique UNIQUE (tenant_id, id);
CREATE TABLE offer_invoice_conversions (
  tenant_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('lite', 'pro')),
  offer_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, product, offer_id),
  UNIQUE (tenant_id, product, invoice_id),
  FOREIGN KEY (tenant_id, product) REFERENCES tenants(id, product) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, offer_id) REFERENCES offers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE RESTRICT
);
-- Ambiguous historical conversions remain visible to the conflict check.
INSERT INTO offer_invoice_conversions (tenant_id, product, offer_id, invoice_id)
SELECT i.tenant_id, t.product, i.source_document_id, min(i.id)
FROM invoices i JOIN offers o ON o.tenant_id=i.tenant_id AND o.id=i.source_document_id
JOIN tenants t ON t.id=i.tenant_id
WHERE COALESCE(i.document_kind,'invoice')='invoice' AND i.revision_of_id IS NULL AND t.product IN ('lite','pro')
GROUP BY i.tenant_id, t.product, i.source_document_id HAVING count(*)=1;
