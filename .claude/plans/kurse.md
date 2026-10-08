# Quotes for the securities the depots hold

## Goal

A page under Finance with one tile per held security: current price,
change over a switchable range (1D · 1W · 1M · 1Y · Max), a sparkline,
and the value of the shares held. Prices come from a quote provider; the
history is kept in our own database so it outlives the provider.

## Decisions

- **Provider:** Onvista's JSON API (`api.onvista.de/api/v1`), undocumented
  but free and without a token; it knows German exchanges and funds,
  including the fund company's own price, and finds a security by ISIN or
  WKN. Yahoo was the first choice but answers a server's requests with 429
  whatever the rate — it wants a browser's TLS fingerprint, as yfinance and
  Portfolio Performance found in 2025 — so it stays only as an option
  (`FINANCE_QUOTE_PROVIDER=yahoo`). The provider sits behind `finance/quote-provider.ts` so EODHD
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
3. **EODHD adapter with news** — built. `finance/quote-provider-eodhd.ts`:
   quotes by ISIN (search, end-of-day, the delayed real-time price) and
   the Financial News API (title, link, date, summary, sentiment).
   Quotes and news are **separate providers** (`setQuoteProvider`,
   `setNewsProvider`): on the free plan EODHD cannot carry quotes every
   five minutes, so the quotes stay with Onvista and EODHD brings the news.
   Configuration (`finance/quote-provider-eodhd-config.ts`): secret
   `EodhdApiToken` (env `EODHD_API_TOKEN`), `FINANCE_EODHD_DAILY_CALLS`
   (default 20), `FINANCE_QUOTE_PROVIDER=eodhd` for quotes on a paid plan.
   No token: no news, quotes from Onvista.
   - The free plan allows 20 API calls a day; a news request costs 5 per
     symbol, so about four securities a day. The scheduler therefore
     keeps a **news budget** of its own, separate from the quote ticks:
     equities only (funds and ETFs get no news worth the calls), the
     securities longest unasked first, at most the budget a day. The
     500 welcome calls cover the first round.
   - `QuoteProvider.news?(symbol, since)` is optional: a provider
     without news leaves it out and everything else keeps working.
   - Table `finance_quote_news`, deduplicated by (position, url), kept 90
     days; `finance_news_source` holds the news provider's symbol per
     position and when it was last asked; `finance_provider_usage` counts
     the calls charged per provider and UTC day (one atomic statement, so
     two runs cannot both spend the last calls). Migration 0229, which
     also adds `security_type` to `finance_quote_symbol`.
   - `finance/news.ts`: `refreshNews` (job `finance-news-refresh`, hourly;
     equities and unknown types only — an unknown type is decided by the
     news provider's resolve; at most once in 20 hours per security; the
     first fetch reaches back 30 days), `GET /finance/quotes/news?key=`
     for a position the caller's depots hold or held.
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
- A security the provider does not know stays `unresolved`, is logged
  with its ISIN, and is asked again after a day — at once when the page's
  refresh button is pressed. The symbol can be set by hand in
  `finance_quote_symbol` until a UI for it exists.
- Every run logs a summary ("quote refresh done": positions, resolved,
  unresolved, fetches, new prices, errors, rate limit). The cadence lives
  in the schedule, so the admin's "run now" always runs.
- Onvista: a security resolves in two calls (search, snapshot) to the
  symbol `TYPE:entityValue:idNotation`; the notation is Xetra, Tradegate,
  Frankfurt, … for shares and the fund company ("KAG") first for funds.
  Host to allow: `api.onvista.de`.
- The sandbox's network policy allows none of the providers; the adapters
  cannot be smoke-tested here, only in the deployed app.
- Onvista's day (`chart_history`) is undocumented beyond `range` and
  `resolution`; the adapter tries `range=D1` with 5-minute, 1-minute and
  default resolution and keeps the first that answers with prices. When
  every variant answers 403 (seen in production for shares), the day's
  price comes from the snapshot instead — one point per tick, so the
  minutes become our own five-minute series — and the chart is not asked
  again for six hours. A day
  or a week on the page reads the closes too, so both show a line before
  any minutes are stored, and a day's change is measured against the
  last close.
