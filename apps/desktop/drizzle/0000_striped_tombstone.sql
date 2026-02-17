CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`iban` text NOT NULL,
	`balance` real NOT NULL,
	`type` text NOT NULL,
	`color` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `active_templates` (
	`id` integer PRIMARY KEY NOT NULL,
	`invoice_template_id` text,
	`offer_template_id` text
);
--> statement-breakpoint
CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`price` real NOT NULL,
	`unit` text NOT NULL,
	`category` text NOT NULL,
	`tax_rate` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sequence` integer NOT NULL,
	`ts` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	`prev_hash` text,
	`hash` text NOT NULL,
	`actor` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_sequence_unique` ON `audit_log` (`sequence`);--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_log` (`entity_type`,`entity_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `client_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`date` text NOT NULL,
	`author` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `client_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`company` text,
	`contact_person` text,
	`street` text NOT NULL,
	`line2` text,
	`zip` text NOT NULL,
	`city` text NOT NULL,
	`country` text NOT NULL,
	`is_default_billing` integer DEFAULT 0 NOT NULL,
	`is_default_shipping` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_client_addresses_client` ON `client_addresses` (`client_id`);--> statement-breakpoint
CREATE TABLE `client_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`email` text NOT NULL,
	`is_default_general` integer DEFAULT 0 NOT NULL,
	`is_default_billing` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_client_emails_client` ON `client_emails` (`client_id`);--> statement-breakpoint
CREATE TABLE `client_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`budget` real NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`description` text,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`contact_person` text NOT NULL,
	`email` text NOT NULL,
	`phone` text NOT NULL,
	`address` text NOT NULL,
	`status` text NOT NULL,
	`avatar` text,
	`tags_json` text NOT NULL,
	`notes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`total` real NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invoice_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` real NOT NULL,
	`method` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text,
	`number` text NOT NULL,
	`client` text NOT NULL,
	`client_email` text NOT NULL,
	`client_address` text,
	`billing_address_json` text,
	`shipping_address_json` text,
	`date` text NOT NULL,
	`due_date` text NOT NULL,
	`service_period` text,
	`amount` real NOT NULL,
	`status` text NOT NULL,
	`dunning_level` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `offer_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offer_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`total` real NOT NULL,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text,
	`number` text NOT NULL,
	`client` text NOT NULL,
	`client_email` text NOT NULL,
	`client_address` text,
	`billing_address_json` text,
	`shipping_address_json` text,
	`date` text NOT NULL,
	`valid_until` text NOT NULL,
	`amount` real NOT NULL,
	`status` text NOT NULL,
	`share_token` text,
	`share_published_at` text,
	`accepted_at` text,
	`accepted_by` text,
	`accepted_email` text,
	`accepted_user_agent` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`active` integer NOT NULL,
	`name` text NOT NULL,
	`interval` text NOT NULL,
	`next_run` text NOT NULL,
	`last_run` text,
	`end_date` text,
	`amount` real NOT NULL,
	`items_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`elements_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` real NOT NULL,
	`type` text NOT NULL,
	`counterparty` text NOT NULL,
	`purpose` text NOT NULL,
	`linked_invoice_id` text,
	`status` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
