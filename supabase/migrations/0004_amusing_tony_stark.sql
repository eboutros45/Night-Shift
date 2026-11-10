ALTER TABLE "login_challenges" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "email" text;--> statement-breakpoint
UPDATE "login_challenges" SET "email" = "users"."email" FROM "users" WHERE "login_challenges"."user_id" = "users"."id";--> statement-breakpoint
ALTER TABLE "login_challenges" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "audience" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_challenges_email" ON "login_challenges" USING btree ("email");--> statement-breakpoint
CREATE INDEX "orders_user" ON "orders" USING btree ("user_id");