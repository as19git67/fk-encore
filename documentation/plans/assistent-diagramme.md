# Assistant: charts beside an answer

Anton asked for charts in the assistant: a line for how a value developed
over time, and pie charts. This note says how they come about and what is
left for later.

## The rule: the server draws from tool results, never the model

A chart shows rows a tool returned — the same rows the model read and the
list under the answer shows. The model neither writes chart data nor picks
the numbers. So a chart cannot show a figure the data does not hold, and it
costs no tokens: blocks never reach the model (`agent.ts`).

The chart is not a block kind of its own but an optional `chart` on a block,
derived in `assistant/present.ts` next to `display` (rules in
`assistant/charts.ts`). That keeps the data in one place (a chart and its
list never disagree), and blocks stored before this change get their chart
when a conversation is read, because `presentBlocks` runs on read too.

```ts
interface BlockChart {
  type: "line" | "bar" | "pie";
  labels: string[];                                  // x values or slices, in order
  series: { name: string; values: (number | null)[] }[];
  format: "money" | "number";                        // how a value reads
  unit?: string;                                     // the currency code or "kWh"
  caption?: string;                                  // one line under the chart
}
```

## Which block gets which chart

| Block | Tool | Chart | When |
|---|---|---|---|
| `analysis` per month, quarter, year | `transaction_totals` | bar (sums per period are flows, not levels) | at least 2 periods |
| `analysis` per tag | `transaction_totals` | pie, else bar | pie when every group has the same sign; at least 2 groups |
| `consumption` | `consumption_report` | bar with the meter's unit | at least 2 periods |
| `readings` | `latest_readings` | line, oldest first | at least 3 readings |
| `positions` | `portfolio_overview` | pie of market value | at least 2 positions with a value |
| `performance` (new) | `portfolio_performance` (new) | line: depot value and invested capital | at least 2 points |

A pie has at most 8 slices: past 7, the smallest fold into „Übrige“. A
pie of a list cut at its limit says so in `caption` („nur die gezeigten
Positionen“). A line keeps at most 120 points; longer histories are thinned
evenly, keeping the first and the last.

## New tool: `portfolio_performance`

The value line Anton named first had no tool: `portfolio_overview` gives the
value today, not its history. `portfolio_performance` reads
`GET /finance/portfolio/performance` (the Portfolio page's chart) for a
period of 1M, YTD, 1Y, 3Y or max, optionally one depot or one security, and
prints start and end value, net inflow, gain, TWR and XIRR, computed by the
server. Its home is the depot area, with an example and a benchmark case.

## Clients

- Web: `components/assistant/AssistantChart.vue` draws `chart` with
  PrimeVue's `Chart` (Chart.js, already used on the finance pages), above the
  rows of the block, visible while the block is folded. Colours are the eight
  categorical slots of the data-viz reference palette, a light and a dark
  step each; legend for two or more series and for every pie; the rows below
  stay the table view.
- iOS: `ChartView.swift` in `F4milAssistant` draws the same spec with Swift
  Charts (`LineMark`, `BarMark`, `SectorMark`; iOS 18 is the floor). The
  package still knows no block kind: it draws whatever `chart` says.

## Later

- „Zeig das als Kuchen“: the model could ask for a type (an argument
  `chart` on the tools that have one). Only once the server's choice proves
  wrong in practice.
- More sources: the balance of an account over time, a quote's history
  (`quotes` with a range), the EÜR as income and expense bars.
