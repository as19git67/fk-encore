# Quotes for the securities the depots hold

## Goal

A page under Finance with one tile per held security: current price,
change over a switchable range (1D · 1W · 1M · 1Y · Max), a sparkline,
and the value of the shares held. Prices come from a quote provider; the
history is kept in our own database so it outlives the provider.

## Decisions

- **Provider:** Yahoo Finance's unofficial JSON endpoints to start — free,
  knows German exchanges and funds, about fifteen minutes delayed, no
  contract. The provider sits behind `finance/quote-provider.ts` so EODHD
  (or another) can replace it without touching the service or the page.
- **History is stored.** `finance_quote` keeps the day's minutes for a
  month and the closes for good. Switching providers re-resolves the
  symbols and backfills, but never deletes what is there.
- **No real-time push.** With fifteen-minute data a WebSocket buys
  nothing; the page polls every minute while open.

## Stages

1. **Provider, cache, scheduler** — done.
   `finance/quote-provider.ts` (interface, `setQuoteProvider` for tests),
   `finance/quote-provider-yahoo.ts` (search by ISIN/WKN, chart endpoint),
   `finance/quotes.ts` (`activePositions`, `refreshQuotes`, `buildQuoteTiles`,
   `GET /finance/quotes?range=`, `POST /finance/quotes/refresh`),
   `finance/quotes-cron.ts` (every 5 min while German markets trade,
   hourly otherwise, 15 min backoff after a 429). Tables
   `finance_quote_symbol`, `finance_quote` (migration 0228).
2. **Page** — `frontend/src/views/finance/QuotesView.vue`: `PageLayout`,
   range in `route.query`, tiles with Chart.js sparklines, a refresh
   button calling `/finance/quotes/refresh`, tile click → position page.
   Entry in `config/modules.ts` next to Portfolio.
3. **Second provider** (EODHD) and a setting to choose, if Yahoo proves
   unreliable.
4. **Optional:** today's price in the portfolio overview and the position
   chart instead of the bank's last snapshot.

## Operations

- After the first deploy the symbols resolve on the first tick; the
  first tick also backfills five years of closes per security. Yahoo
  answers 429 when asked too often; the tick then stops and the next
  waits a quarter of an hour. With a few dozen positions this has not
  been an issue.
- A security the provider does not know stays `unresolved` and is asked
  again after a week. The symbol can be set by hand in
  `finance_quote_symbol` until a UI for it exists.
- The sandbox's network policy does not allow `query1/query2.finance.yahoo.com`;
  the adapter cannot be smoke-tested here, only in the deployed app.
