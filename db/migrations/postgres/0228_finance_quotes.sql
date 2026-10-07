-- Quotes of the securities the depots hold.
--
-- The provider's symbol per position, resolved once from ISIN/WKN, and the
-- prices fetched for it. Kept here so the history outlives the provider.
CREATE TABLE "finance_quote_symbol" (
  "position_key" text PRIMARY KEY NOT NULL,
  "isin" text,
  "wkn" text,
  "symbol" text,
  "provider" text NOT NULL,
  "name" text,
  "exchange" text,
  "currency" text,
  "resolved_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failure" text,
  "backfilled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "finance_quote" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "position_key" text NOT NULL,
  "at" timestamp with time zone NOT NULL,
  "price" numeric(20, 6) NOT NULL,
  "currency" text,
  "kind" text NOT NULL,
  "source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_quote" ADD CONSTRAINT "finance_quote_position_key_finance_quote_symbol_position_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."finance_quote_symbol"("position_key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_quote_key_at_kind" ON "finance_quote" USING btree ("position_key","at","kind");
