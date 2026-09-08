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