-- News about the held securities, and the security type of a quote symbol.
--
-- The security type lets the news go to equities only: funds and ETFs
-- rarely get news worth a metered provider's calls. The usage table
-- counts the calls charged against a provider's daily allowance.
ALTER TABLE "finance_quote_symbol" ADD COLUMN "security_type" text;
--> statement-breakpoint
CREATE TABLE "finance_news_source" (
  "position_key" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "symbol" text,
  "resolved_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "finance_quote_news" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "position_key" text NOT NULL,
  "provider" text NOT NULL,
  "url" text NOT NULL,
  "title" text NOT NULL,
  "source" text,
  "at" timestamp with time zone NOT NULL,
  "summary" text,
  "sentiment" real,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_quote_news_key_url" ON "finance_quote_news" USING btree ("position_key","url");
--> statement-breakpoint
CREATE INDEX "finance_quote_news_key_at" ON "finance_quote_news" USING btree ("position_key","at");
--> statement-breakpoint
CREATE TABLE "finance_provider_usage" (
  "provider" text NOT NULL,
  "day" date NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "finance_provider_usage_provider_day_pk" PRIMARY KEY("provider","day")
);
