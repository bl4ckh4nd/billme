CREATE TABLE `account_keywords` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`chart` text NOT NULL,
	`account_number` text NOT NULL,
	`keyword` text NOT NULL,
	`source` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_account_keywords_tenant_chart_account` ON `account_keywords` (`tenant_id`,`chart`,`account_number`);--> statement-breakpoint
CREATE INDEX `idx_account_keywords_tenant_chart_keyword` ON `account_keywords` (`tenant_id`,`chart`,`keyword`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_keywords_unique` ON `account_keywords` (`tenant_id`,`chart`,`account_number`,`keyword`);--> statement-breakpoint
CREATE TABLE `account_mappings_hgb` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`chart` text NOT NULL,
	`account_number` text NOT NULL,
	`statement_type` text NOT NULL,
	`position_key` text NOT NULL,
	`position_label` text NOT NULL,
	`balance_side` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_mappings_unique` ON `account_mappings_hgb` (`tenant_id`,`chart`,`account_number`,`statement_type`);--> statement-breakpoint
CREATE TABLE `account_suggestion_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`chart` text NOT NULL,
	`priority` integer NOT NULL,
	`field` text NOT NULL,
	`operator` text NOT NULL,
	`value` text NOT NULL,
	`target_account_number` text NOT NULL,
	`flow_type` text DEFAULT 'any' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_account_suggestion_rules_tenant_chart_priority` ON `account_suggestion_rules` (`tenant_id`,`chart`,`priority`);--> statement-breakpoint
CREATE TABLE `accounting_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`period` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`status` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounting_periods_tenant_period` ON `accounting_periods` (`tenant_id`,`period`);--> statement-breakpoint
CREATE TABLE `asset_depreciation_schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`asset_id` text NOT NULL,
	`year` integer NOT NULL,
	`amount` real NOT NULL,
	`months` integer NOT NULL,
	`status` text NOT NULL,
	`journal_entry_id` text,
	`posted_at` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_asset_schedule_tenant_asset_year` ON `asset_depreciation_schedule` (`tenant_id`,`asset_id`,`year`);--> statement-breakpoint
CREATE TABLE `asset_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`asset_id` text NOT NULL,
	`type` text NOT NULL,
	`movement_date` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`proceeds` real,
	`gain_loss` real,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_asset_movements_tenant_asset_date` ON `asset_movements` (`tenant_id`,`asset_id`,`movement_date`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`asset_number` text NOT NULL,
	`name` text NOT NULL,
	`asset_class` text NOT NULL,
	`status` text NOT NULL,
	`activation_date` text NOT NULL,
	`acquisition_cost` real NOT NULL,
	`useful_life_years` integer,
	`depreciation_method` text NOT NULL,
	`cost_center` text NOT NULL,
	`location` text NOT NULL,
	`receipt_linked` integer DEFAULT 0 NOT NULL,
	`supplier` text,
	`invoice_ref` text,
	`asset_account_number` text NOT NULL,
	`disposal_date` text,
	`disposal_proceeds` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assets_tenant_number` ON `assets` (`tenant_id`,`asset_number`);--> statement-breakpoint
CREATE TABLE `bank_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` real NOT NULL,
	`type` text NOT NULL,
	`counterparty` text NOT NULL,
	`purpose` text NOT NULL,
	`linked_invoice_id` text,
	`status` text NOT NULL,
	`source_transaction_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bank_transactions_tenant_date` ON `bank_transactions` (`tenant_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_bank_transactions_status` ON `bank_transactions` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `booking_draft_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`draft_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`account_number` text NOT NULL,
	`debit_amount` real DEFAULT 0 NOT NULL,
	`credit_amount` real DEFAULT 0 NOT NULL,
	`tax_code` text,
	`tax_case_key` text,
	`tax_rate` real,
	`net_amount` real,
	`tax_amount` real,
	`gross_amount` real,
	`country_code` text,
	`counterparty_vat_id` text,
	`evidence_type` text,
	`evidence_reference` text,
	`cost_center` text,
	`memo` text,
	FOREIGN KEY (`draft_id`) REFERENCES `booking_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_booking_draft_lines_draft` ON `booking_draft_lines` (`draft_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `booking_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`transaction_id` text NOT NULL,
	`workflow_status` text NOT NULL,
	`draft_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_booking_drafts_tenant_transaction` ON `booking_drafts` (`tenant_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_booking_drafts_updated` ON `booking_drafts` (`tenant_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `datev_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`file_path` text NOT NULL,
	`record_count` integer NOT NULL,
	`from_date` text,
	`to_date` text,
	`created_at` text NOT NULL,
	`meta_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_datev_exports_tenant_created` ON `datev_exports` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `draft_validation_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`draft_id` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`field_path` text,
	`blocking` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`issue_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `booking_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_draft_validation_issues_draft` ON `draft_validation_issues` (`draft_id`);--> statement-breakpoint
CREATE TABLE `dunning_history` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`invoice_number` text NOT NULL,
	`dunning_level` integer NOT NULL,
	`days_overdue` integer NOT NULL,
	`fee_applied` real NOT NULL,
	`email_sent` integer DEFAULT 0 NOT NULL,
	`email_log_id` text,
	`processed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dunning_history_invoice` ON `dunning_history` (`invoice_id`,`dunning_level`);--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`document_type` text NOT NULL,
	`document_id` text NOT NULL,
	`document_number` text NOT NULL,
	`recipient_email` text NOT NULL,
	`recipient_name` text NOT NULL,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`sent_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_email_log_document` ON `email_log` (`document_type`,`document_id`);--> statement-breakpoint
CREATE TABLE `eur_classifications` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`tax_year` integer NOT NULL,
	`eur_line_id` text,
	`excluded` integer DEFAULT 0 NOT NULL,
	`vat_mode` text DEFAULT 'none' NOT NULL,
	`note` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`eur_line_id`) REFERENCES `eur_lines`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_eur_classifications_source_year` ON `eur_classifications` (`source_type`,`source_id`,`tax_year`);--> statement-breakpoint
CREATE INDEX `idx_eur_classifications_year` ON `eur_classifications` (`tax_year`);--> statement-breakpoint
CREATE TABLE `eur_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tax_year` integer NOT NULL,
	`kennziffer` text,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`exportable` integer DEFAULT 1 NOT NULL,
	`sort_order` integer NOT NULL,
	`computed_from_json` text,
	`source_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_eur_lines_year_sort` ON `eur_lines` (`tax_year`,`sort_order`);--> statement-breakpoint
CREATE TABLE `eur_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tax_year` integer NOT NULL,
	`priority` integer NOT NULL,
	`field` text NOT NULL,
	`operator` text NOT NULL,
	`value` text NOT NULL,
	`target_eur_line_id` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`target_eur_line_id`) REFERENCES `eur_lines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_eur_rules_year_priority` ON `eur_rules` (`tax_year`,`priority`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`profile` text NOT NULL,
	`file_name` text NOT NULL,
	`file_sha256` text NOT NULL,
	`mapping_json` text NOT NULL,
	`imported_count` integer NOT NULL,
	`skipped_count` integer NOT NULL,
	`error_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`rolled_back_at` text,
	`rollback_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`entry_number` integer NOT NULL,
	`posting_date` text NOT NULL,
	`document_date` text,
	`booking_text` text NOT NULL,
	`reference` text,
	`period` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`status` text NOT NULL,
	`source_draft_id` text,
	`reversed_entry_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_journal_entries_tenant_entry_number` ON `journal_entries` (`tenant_id`,`entry_number`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_tenant_posting_date` ON `journal_entries` (`tenant_id`,`posting_date`);--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`entry_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`account_number` text NOT NULL,
	`debit_amount` real DEFAULT 0 NOT NULL,
	`credit_amount` real DEFAULT 0 NOT NULL,
	`tax_code` text,
	`tax_case_key` text,
	`tax_rate` real,
	`net_amount` real,
	`tax_amount` real,
	`gross_amount` real,
	`country_code` text,
	`counterparty_vat_id` text,
	`evidence_type` text,
	`evidence_reference` text,
	`cost_center` text,
	`memo` text,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_journal_lines_entry` ON `journal_lines` (`entry_id`,`line_no`);--> statement-breakpoint
CREATE INDEX `idx_journal_lines_account` ON `journal_lines` (`tenant_id`,`account_number`);--> statement-breakpoint
CREATE TABLE `journal_posting_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`entry_id` text NOT NULL,
	`debit_line_id` text NOT NULL,
	`credit_line_id` text NOT NULL,
	`amount` real NOT NULL,
	`tax_case_key` text,
	`datev_bu_key` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_journal_posting_pairs_entry` ON `journal_posting_pairs` (`tenant_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `ledger_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`chart` text NOT NULL,
	`account_number` text NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ledger_accounts_chart_number` ON `ledger_accounts` (`chart`,`account_number`);--> statement-breakpoint
CREATE INDEX `idx_ledger_accounts_chart` ON `ledger_accounts` (`chart`);--> statement-breakpoint
CREATE INDEX `idx_ledger_accounts_name` ON `ledger_accounts` (`name`);--> statement-breakpoint
CREATE TABLE `number_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`number` text NOT NULL,
	`counter_value` integer NOT NULL,
	`status` text NOT NULL,
	`document_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_number_reservations_status_kind` ON `number_reservations` (`status`,`kind`);--> statement-breakpoint
CREATE TABLE `pro_workflow_entries` (
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`transaction_id` text NOT NULL,
	`transaction_json` text NOT NULL,
	`draft_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `transaction_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_pro_workflow_entries_updated` ON `pro_workflow_entries` (`tenant_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `report_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`report_type` text NOT NULL,
	`args_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_report_snapshots_tenant_type` ON `report_snapshots` (`tenant_id`,`report_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `tax_case_account_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`chart` text NOT NULL,
	`tax_case_key` text NOT NULL,
	`role` text NOT NULL,
	`account_number` text NOT NULL,
	`datev_bu_key` text,
	`valid_from` text,
	`valid_to` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tax_case_key`) REFERENCES `tax_cases`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tax_case_account_mappings_chart_case` ON `tax_case_account_mappings` (`chart`,`tax_case_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tax_case_account_mappings_unique` ON `tax_case_account_mappings` (`chart`,`tax_case_key`,`role`);--> statement-breakpoint
CREATE TABLE `tax_cases` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`mechanism` text NOT NULL,
	`default_rate` real DEFAULT 0 NOT NULL,
	`requires_counterparty_vat_id` integer DEFAULT 0 NOT NULL,
	`requires_country` integer DEFAULT 0 NOT NULL,
	`requires_evidence` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tax_cases_active` ON `tax_cases` (`active`,`key`);--> statement-breakpoint
CREATE TABLE `vat_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`draft_id` text,
	`entry_id` text,
	`line_id` text,
	`tax_case_key` text NOT NULL,
	`evidence_type` text,
	`evidence_reference` text,
	`country_code` text,
	`counterparty_vat_id` text,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_vat_evidence_entry` ON `vat_evidence` (`tenant_id`,`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_vat_evidence_draft` ON `vat_evidence` (`tenant_id`,`draft_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `default_skr_account_number` text NOT NULL;--> statement-breakpoint
ALTER TABLE `client_projects` ADD `code` text;--> statement-breakpoint
ALTER TABLE `client_projects` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `client_projects` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `client_projects` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `customer_number` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `tax_profile_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_clients_customer_number_unique` ON `clients` (`customer_number`);--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `article_id` text;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `category` text;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `unit` text;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `discount_percent` real;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `tax_rate` real;--> statement-breakpoint
ALTER TABLE `invoices` ADD `client_number` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `tax_mode` text DEFAULT 'standard_vat' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `tax_meta_json` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `tax_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `offer_items` ADD `article_id` text;--> statement-breakpoint
ALTER TABLE `offer_items` ADD `category` text;--> statement-breakpoint
ALTER TABLE `offer_items` ADD `unit` text;--> statement-breakpoint
ALTER TABLE `offer_items` ADD `discount_percent` real;--> statement-breakpoint
ALTER TABLE `offer_items` ADD `tax_rate` real;--> statement-breakpoint
ALTER TABLE `offers` ADD `client_number` text;--> statement-breakpoint
ALTER TABLE `offers` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `offers` ADD `tax_mode` text DEFAULT 'standard_vat' NOT NULL;--> statement-breakpoint
ALTER TABLE `offers` ADD `tax_meta_json` text;--> statement-breakpoint
ALTER TABLE `offers` ADD `tax_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `offers` ADD `decision` text;--> statement-breakpoint
ALTER TABLE `offers` ADD `decision_text_version` text;--> statement-breakpoint
ALTER TABLE `recurring_profiles` ADD `tax_mode` text DEFAULT 'standard_vat' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurring_profiles` ADD `tax_meta_json` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `dedup_hash` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `import_batch_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `deleted_at` text;