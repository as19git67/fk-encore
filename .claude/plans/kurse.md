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

1. **Provider, cache, scheduler** — done (#1467).
   `finance/quote-provider.ts` (interface, `setQuoteProvider` for tests),
   `finance/quote-provider-yahoo.ts` (search by ISIN/WKN, chart endpoint),
   `finance/quotes.ts` (`activePositions`, `refreshQuotes`, `buildQuoteTiles`,
   `GET /finance/quotes?range=`, `POST /finance/quotes/refresh`),
   `finance/quotes-cron.ts` (every 5 min while German markets trade,
   hourly otherwise, 15 min backoff after a 429). Tables
   `finance_quote_symbol`, `finance_quote` (migration 0228).
2. **Page** — done (#1468). `frontend/src/views/finance/QuotesView.vue`: `PageLayout`,
   range in `route.query`, tiles with Chart.js sparklines, a refresh
   button calling `/finance/quotes/refresh`, tile click → position page.
   Entry in `config/modules.ts` next to Portfolio.
3. **EODHD adapter with news.** `finance/quote-provider-eodhd.ts`:
   quotes by ISIN (EODHD's search knows ISINs), and the Financial News
   API (title, link, source, date, summary, tags, sentiment). Token from
   the secret `EodhdApiToken`; the provider in force is a setting
   (`yahoo` | `eodhd`), Yahoo stays the default without a token.
   - The free plan allows 20 API calls a day; a news request costs 5 per
     symbol, so about four securities a day. The scheduler therefore
     keeps a **news budget** of its own, separate from the quote ticks:
     equities only (funds and ETFs get no news worth the calls), the
     securities longest unasked first, at most the budget a day. The
     500 welcome calls cover the first round.
   - `QuoteProvider.news?(symbol, since)` is optional: a provider
     without news leaves it out and everything else keeps working.
   - Table `finance_quote_news` (position_key, id, title, url, source,
     at, summary, sentiment, provider), deduplicated by `id`, kept 90
     days. The news history is ours like the prices.
4. **News on the pages.** The position page gets a "Nachrichten"
   section (title, source, time, link opens externally, a sentiment
   marker where the provider gives one); the quotes tile shows a count
   of items newer than the last visit, linking to the position page.
5. **Yahoo news** as the free second way: the RSS feed per symbol
   (`feeds.finance.yahoo.com/rss/2.0/headline?s=SYMBOL`, no cookie
   needed), `id` from the article URL, same table and pages. Coverage
   of German securities is thin, so it complements rather than replaces
   EODHD.
6. **Optional:** today's price in the portfolio overview and the position
   chart instead of the bank's last snapshot.

## Operations

- After the first deploy the symbols resolve on the first tick; the
  first tick also backfills five years of closes per security.
- Yahoo refuses the search without its consent cookie and crumb, whatever
  the rate: the adapter opens that session once an hour (cookie from
  `fc.yahoo.com`, crumb from `getcrumb`), renews it once when refused,
  and only then reports a rate limit; the tick then stops and the next
  waits a quarter of an hour. Hosts to allow: `fc.yahoo.com`,
  `query1.finance.yahoo.com`, `query2.finance.yahoo.com` (later
  `feeds.finance.yahoo.com` for news, `eodhd.com` for EODHD).
- A security the provider does not know stays `unresolved` and is asked
  again after a week. The symbol can be set by hand in
  `finance_quote_symbol` until a UI for it exists.
- The sandbox's network policy does not allow `query1/query2.finance.yahoo.com`;
  the adapter cannot be smoke-tested here, only in the deployed app.
