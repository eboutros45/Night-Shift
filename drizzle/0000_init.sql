CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`venue_name` text NOT NULL,
	`venue_address` text DEFAULT '' NOT NULL,
	`city` text DEFAULT 'Beirut' NOT NULL,
	`lineup` text DEFAULT '[]' NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`max_per_order` integer DEFAULT 6 NOT NULL,
	`age_policy` text DEFAULT '18+ only. Valid ID required at the door.' NOT NULL,
	`refund_policy` text DEFAULT 'All sales are final. Tickets are non-refundable but may be transferred.' NOT NULL,
	`poster_key` text,
	`theme` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`event_id` text,
	`action` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `journal_entity` ON `journal` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `journal_event_action` ON `journal` (`event_id`,`action`,`at`);--> statement-breakpoint
CREATE INDEX `journal_at` ON `journal` (`at`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`access_token` text NOT NULL,
	`event_id` text NOT NULL,
	`wave_id` text,
	`status` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`is_comp` integer DEFAULT false NOT NULL,
	`customer_name` text NOT NULL,
	`customer_email` text NOT NULL,
	`customer_phone` text NOT NULL,
	`expires_at` integer,
	`proof_key` text,
	`proof_mime` text,
	`txn_ref` text,
	`submitted_at` integer,
	`decided_at` integer,
	`decided_by` text,
	`reject_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wave_id`) REFERENCES `waves`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_reference_unique` ON `orders` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_access_token_unique` ON `orders` (`access_token`);--> statement-breakpoint
CREATE INDEX `orders_wave_status` ON `orders` (`wave_id`,`status`);--> statement-breakpoint
CREATE INDEX `orders_status_expires` ON `orders` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `orders_event_status` ON `orders` (`event_id`,`status`);--> statement-breakpoint
CREATE TABLE `page_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`event_id` text,
	`visitor` text NOT NULL,
	`path` text NOT NULL,
	`referrer_host` text,
	`device` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `page_views_type_at` ON `page_views` (`type`,`at`);--> statement-breakpoint
CREATE INDEX `page_views_event` ON `page_views` (`event_id`,`type`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`order_id` text NOT NULL,
	`event_id` text NOT NULL,
	`attendee_name` text NOT NULL,
	`status` text DEFAULT 'VALID' NOT NULL,
	`checked_in_at` integer,
	`checked_in_by` text,
	`revoked_at` integer,
	`revoke_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_token_unique` ON `tickets` (`token`);--> statement-breakpoint
CREATE INDEX `tickets_event_status` ON `tickets` (`event_id`,`status`);--> statement-breakpoint
CREATE INDEX `tickets_order` ON `tickets` (`order_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `waves` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`price_cents` integer NOT NULL,
	`capacity` integer NOT NULL,
	`mode` text DEFAULT 'MANUAL' NOT NULL,
	`manual_open` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waves_event_position` ON `waves` (`event_id`,`position`);