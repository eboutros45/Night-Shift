ALTER TABLE "orders" ADD COLUMN "pay_method" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "price_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "paid_at" bigint;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "paid_via" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "paid_by" text;--> statement-breakpoint
UPDATE "orders" SET "pay_method" = 'WHISH' WHERE "submitted_at" IS NOT NULL AND "channel" = 'ONLINE';--> statement-breakpoint
UPDATE "tickets" SET
  "price_cents" = "orders"."unit_price_cents",
  "paid_at" = COALESCE("orders"."decided_at", "tickets"."created_at"),
  "paid_via" = CASE WHEN "orders"."is_comp" OR "orders"."unit_price_cents" = 0 THEN 'COMP' WHEN "orders"."channel" = 'DOOR' THEN 'CASH' ELSE 'WHISH' END,
  "paid_by" = "orders"."decided_by"
FROM "orders" WHERE "tickets"."order_id" = "orders"."id";
