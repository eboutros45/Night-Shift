ALTER TABLE `events` ADD `organizer` text DEFAULT 'Night Shift' NOT NULL;--> statement-breakpoint
ALTER TABLE `waves` ADD `opens_at` integer;--> statement-breakpoint
ALTER TABLE `waves` ADD `closes_at` integer;