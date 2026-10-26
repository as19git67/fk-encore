import type { Area } from "./index";

export const DEPOT_AREA: Area = {
  id: "depot",
  description: "Depot: securities and positions, portfolio value and gains, buys, sells and dividends, quotes of today, news about a position.",
  tools: ["portfolio_overview", "position_detail", "depot_transactions", "quotes", "position_news"],
  rules: [],
  examples: [
    '"Wie steht mein Depot, und was hat Beispiel AG dieses Jahr an Dividende gebracht?" → portfolio_overview → depot_transactions(position = the key the overview printed, kind = "dividend", from/to = this year) → repeat the figures the tools printed (never add them up yourself); for the price today, quotes(q = the name); for news, position_news(key).',
  ],
  keywords:
    "depot|wertpapier|aktie|fonds|etf|kurs|dividende|portfolio|position|vorabpauschale|"
    + "security|securities|share|stock|quote|dividend",
};
