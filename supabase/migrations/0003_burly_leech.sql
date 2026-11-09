CREATE TABLE "login_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_challenges_user" ON "login_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_challenges_expiry" ON "login_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "staff_sessions_user" ON "staff_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_sessions_expiry" ON "staff_sessions" USING btree ("expires_at");