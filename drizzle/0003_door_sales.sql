ALTER TABLE `events` ADD `door_price_cents` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `door_limit` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `channel` text DEFAULT 'ONLINE' NOT NULL;