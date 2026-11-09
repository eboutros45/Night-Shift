CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"organizer" text DEFAULT 'Night Shift' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint,
	"venue_name" text NOT NULL,
	"venue_address" text DEFAULT '' NOT NULL,
	"city" text DEFAULT 'Beirut' NOT NULL,
	"lineup" text DEFAULT '[]' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"max_per_order" integer DEFAULT 6 NOT NULL,
	"max_per_buyer" integer DEFAULT 6 NOT NULL,
	"door_price_cents" integer,
	"door_limit" integer,
	"age_policy" text DEFAULT '18+ only. Valid ID required at the door.' NOT NULL,
	"refund_policy" text DEFAULT 'All sales are final. Tickets are non-refundable but may be transferred.' NOT NULL,
	"poster_key" text,
	"theme" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"actor" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"event_id" text,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"data" text
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"access_token" text NOT NULL,
	"event_id" text NOT NULL,
	"wave_id" text,
	"status" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"is_comp" boolean DEFAULT false NOT NULL,
	"channel" text DEFAULT 'ONLINE' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text NOT NULL,
	"expires_at" bigint,
	"proof_key" text,
	"proof_mime" text,
	"txn_ref" text,
	"submitted_at" bigint,
	"decided_at" bigint,
	"decided_by" text,
	"reject_reason" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "orders_reference_unique" UNIQUE("reference"),
	CONSTRAINT "orders_access_token_unique" UNIQUE("access_token")
);
--> statement-breakpoint
CREATE TABLE "page_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"type" text NOT NULL,
	"event_id" text,
	"visitor" text NOT NULL,
	"path" text NOT NULL,
	"referrer_host" text,
	"device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"order_id" text NOT NULL,
	"event_id" text NOT NULL,
	"attendee_name" text NOT NULL,
	"status" text DEFAULT 'VALID' NOT NULL,
	"checked_in_at" bigint,
	"checked_in_by" text,
	"revoked_at" bigint,
	"revoke_reason" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "tickets_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "waves" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"capacity" integer NOT NULL,
	"mode" text DEFAULT 'MANUAL' NOT NULL,
	"manual_open" boolean DEFAULT false NOT NULL,
	"opens_at" bigint,
	"closes_at" bigint
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waves" ADD CONSTRAINT "waves_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entity" ON "journal" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "journal_event_action" ON "journal" USING btree ("event_id","action","at");--> statement-breakpoint
CREATE INDEX "journal_at" ON "journal" USING btree ("at");--> statement-breakpoint
CREATE INDEX "orders_wave_status" ON "orders" USING btree ("wave_id","status");--> statement-breakpoint
CREATE INDEX "orders_status_expires" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "orders_event_status" ON "orders" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "page_views_type_at" ON "page_views" USING btree ("type","at");--> statement-breakpoint
CREATE INDEX "page_views_event" ON "page_views" USING btree ("event_id","type");--> statement-breakpoint
CREATE INDEX "tickets_event_status" ON "tickets" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "tickets_order" ON "tickets" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waves_event_position" ON "waves" USING btree ("event_id","position");