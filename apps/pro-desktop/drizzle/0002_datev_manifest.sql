ALTER TABLE `datev_exports` ADD `sha256` text;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `byte_size` integer;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `encoding` text;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `header_version` integer;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `format_version` integer;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `chart` text;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `source_snapshot_hash` text;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `manifest_json` text;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `status` text;
--> statement-breakpoint
ALTER TABLE `datev_exports` ADD `validation_json` text;
--> statement-breakpoint
CREATE TRIGGER `datev_exports_no_update`
BEFORE UPDATE ON `datev_exports`
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'datev_exports are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `datev_exports_no_delete`
BEFORE DELETE ON `datev_exports`
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'datev_exports are immutable');
END;
