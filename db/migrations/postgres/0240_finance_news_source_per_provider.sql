-- Yahoo's RSS feed as a second way to news (documentation/plans/kurse.md,
-- stage 5). Several news providers may now serve the same security, each
-- with its own symbol and its own "last asked": the source row is kept per
-- position and provider. Existing rows (EODHD) keep their state.
ALTER TABLE "finance_news_source" DROP CONSTRAINT "finance_news_source_pkey";
--> statement-breakpoint
ALTER TABLE "finance_news_source" ADD PRIMARY KEY ("position_key", "provider");
