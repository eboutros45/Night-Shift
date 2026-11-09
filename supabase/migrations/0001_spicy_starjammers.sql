CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"reset_at" bigint NOT NULL,
	"reported" boolean DEFAULT false NOT NULL
);
