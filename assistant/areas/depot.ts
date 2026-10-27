import type { Area } from "./index";

export const DEPOT_AREA: Area = {
  id: "depot",
  description: "Depot: securities and positions, portfolio value and gains, buys, sells and dividends, quotes of today, news about a position.",
  tools: ["portfolio_overview", "position_detail", "depot_transactions", "quotes", "position_news"],
  rules: [
    'A security is named to position_detail, depot_transactions and position_news by the key in the rows of portfolio_overview or quotes (the ISIN, e.g. DE0000000001), which the question never contains: find the row by its name first (quotes(q = name) or portfolio_overview(q = name)), then call with that key. A depot is named by its account id: list_accounts shows the depots with their ids, and portfolio_overview(account_ids = [id]) lists what lies in one of them.',
  ],
  examples: [
    '"Wie steht mein Depot, und was hat Beispiel AG dieses Jahr an Dividende gebracht?" → portfolio_overview → depot_transactions(position = the key the overview printed, kind = "dividend", from/to = this year) → repeat the figures the tools printed (never add them up yourself); for the price today, quotes(q = the name); for news, position_news(key).',
    '"Wie steht die Muster AG heute, und was gibt es Neues?" → quotes(q = "Muster AG") → position_news(key = the key column of that row, e.g. "DE0000000002", never the name) → the price and change as printed, then the news.',
    '"Welche Wertpapiere liegen im Depot bei der Musterbank?" → list_accounts → portfolio_overview(account_ids = [the id of the depot whose label names the Musterbank]) → the positions as printed, with their values.',
  ],
  keywords:
    "depot|wertpapier|aktie|fonds|etf|kurs|dividende|portfolio|position|vorabpauschale|"
    + "security|securities|share|stock|quote|dividend",
};
