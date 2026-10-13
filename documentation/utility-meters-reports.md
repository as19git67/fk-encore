# Meter Reports — Expansion Plan (Issue #792, Stage 6)

Supplement to `documentation/utility-meters.md` §5. Describes which analyses
make sense beyond the existing report MVP, what data and assumptions are
missing for them, and in which order they should be implemented.

Status: **Stage 6 fully implemented** (6a–6e), as are the items that were
initially deferred: season profile A3 (#1022), weather adjustment C3
(#1023), advance-payment comparison E3 (with stage 8, #1018) and the
day/week granularity (#1024). Details in `documentation/utility-meters.md`
§5.1, §5.2.5, §5.2.6, §6.1.

---

## 1. Current state (what already exists)

| Building block | Location | Content |
|---|---|---|
| Consumption series per meter | `GET /meters/:id/report` | Monthly/yearly buckets from reading intervals, across device replacements |
| Aggregated energy report | `GET /meters/reports/energy` | Grid import, feed-in, production, self-consumption, self-sufficiency, self-consumption rate, heat pump/heating/hot water/wallbox breakdown, PV shares |
| Cost calculation | `tariffs.service.ts` | Grid import costs, base price, feed-in revenue, avoided grid import, PV benefit, net electricity costs, `noPvElectricityCostEur` |
| Tariff master data | `meter_electricity_tariffs` | Unit price, base price, feed-in tariff, self-consumption value, PV investment, opportunity costs, payback years |
| Evaluation in the frontend | `MetersView.vue`, `MeterDetailView.vue` | Averages, linear trend slope (grid import + self-sufficiency only), year-to-date comparison with the previous year |

Existing metering points: grid electricity import/feed-in, PV production,
heat pump overall, underfloor heating (+PV), hot water (+PV), EV wallbox (+PV),
4 operating-hours meters (compressor, primary pump, heating pump, hot water
pump), water.

### 1.1 Known gaps in the current state

> All five items are fixed: 1–4 with stage 6a/6b, item 5 (PV investment)
> with 6c.

1. **Wallbox missing from the energy report.** `ev_charger_total` / `ev_charger_pv`
   are implemented in `MeterRole`, in `meters_role_check` (migration 0126) and
   in `reports.service.ts`, but the former history import
   (since removed) did not map `e_auto_wallbox` / `e_auto_pv`, and
   no migration backfills them. Today the role has to be set
   manually in the UI, otherwise all wallbox metrics stay `null`.
2. **Bucket allocation without interpolation.** A reading interval is
   attributed entirely to the bucket of its *start time*. Anyone who reads on
   the 3rd and on the 5th of the following month shifts half of the monthly consumption.
   For yearly buckets and for the previous-year comparison this distorts noticeably.
3. **Trend only in the frontend, only for two metrics.** The regression lives
   in `MetersView.vue` and covers grid import + self-sufficiency — not household
   electricity, heating, hot water, wallbox, water.
4. **No seasonal adjustment.** Raw monthly values of a heating system are not
   comparable between January and July; a trend line over
   12 raw months mostly measures the season.
5. **PV investment unused.** `pv_investment_*` and the result cells taken over
   from the Excel sheet (`opportunity_cost_*`, `amortization_years`)
   are stored but enter no calculation. The latter have since been dropped:
   they were results, not inputs — what remains is
   `expected_return_rate` as the only assumption behind them (migration 0150).

---

## 2. Report ideas

Grouped by benefit. The wishes named by the client are marked with ⭐.

### A — PV profitability

| # | Report | Content | Needs |
|---|---|---|---|
| A1 ⭐ | **Cumulative PV savings** | Cumulative curve "electricity costs with PV" vs. "hypothetical costs without PV" since commissioning; difference area = savings. Already available per bucket as `netElectricityCostEur` / `noPvElectricityCostEur` — only cumulation + presentation are missing. | — |
| A2 ⭐ | **Payback** | Investment (net + VAT) minus cumulative PV benefit → remaining amount, forecast payback date from the average of the last 12 months. Second line *incl.* opportunity costs: forgone return, computed with compound interest from `expected_return_rate` — not maintained as a finished amount. | `pv_investment_*`, `expected_return_rate` |
| A3 ✅ | **Season profile self-sufficiency/self-consumption** | Heatmap year × month for self-sufficiency and self-consumption rate. Shows at a glance in which months the battery/system carries and whether this improves over the years. `GET /meters/reports/season-profile` (#1022). | — |
| A4 | **Yield per kWp / performance ratio** | Annual yield per kWp against previous years — the only reliable early indicator of system degradation or dirty modules. | System capacity in kWp (new master-data assumption; it is needed anyway for the correct feed-in capacity tier, see `documentation/utility-meters.md` §5.2) |

### B — Technology comparison (counterfactual)

These are model calculations, not measurements. What matters is that every
assumption is visible, dated and editable — otherwise the number is worthless.
The presentation therefore always comes with a collapsible assumptions box.

| # | Report | Calculation | Needs |
|---|---|---|---|
| B1 ⭐ | **Heat pump vs. gas heating** | Heat quantity = (heating + hot water) [kWh el.] × JAZ (seasonal performance factor). Gas demand = heat quantity ÷ boiler efficiency. Gas costs = gas demand × gas price + gas base price. Compared with the *actual* electricity costs for heating+hot water (PV share at the self-consumption value, grid share at the unit price). Output: €/month, €/year, cumulative. | Assumptions: JAZ (or separately heating/hot water), boiler efficiency, gas price time series, gas base price |
| B2 ⭐ | **EV vs. petrol car** | km = wallbox kWh ÷ consumption [kWh/100 km] × 100. Petrol demand = km ÷ 100 × [l/100 km]. Petrol costs = liters × petrol price time series. EV costs = PV share × self-consumption value + grid share × unit price. Output: €/month, €/year, cumulative, additionally "ct/km" of both variants. | Role fix (§1.1.1); assumptions: kWh/100 km, l/100 km, petrol price time series. Optional: charging-loss factor |
| B3 | **CO₂ balance** | Avoided CO₂ from PV (self-consumption + feed-in × grid-mix factor) as well as from B1/B2 (natural gas 0.201 kg/kWh, petrol 2.37 kg/l). Grid import with the year-specific grid mix. Falls out almost for free once B1/B2 exist. | Grid-mix factor per year (assumption time series) |
| B4 | **Sanity check of the JAZ from operating hours** | Compressor hours × estimated power consumption against actual heat pump electricity consumption — checks the plausibility of the JAZ assumed for B1 without having a heat meter. Honestly only an order of magnitude, but better than an unchecked assumption. | — |

> Note on reliability: B1 stands and falls with the JAZ. Without a
> heat meter it is estimated; the report should therefore show the savings
> as a **range** over JAZ ± 0.5 rather than as a single figure. The same applies
> to B2 with the real-world consumption of the combustion car.

### C — Consumption trends ⭐

Core of the wish: "do I tend to use more or less?" — per metric
household electricity (without heating/hot water/wallbox), heating, hot water, wallbox,
water.

| # | Report | Content |
|---|---|---|
| C1 | **Trend dashboard** | One tile per metric: current 12-month value, change vs. the 12 months before (absolute + %), direction arrow, sparkline. Additionally slope per year from linear regression over the **rolling 12-month sum** — this removes the season and makes the trend actually readable. |
| C2 | **Previous-year comparison per bucket** | `compare=previous_year`: every month/year gets `previousValue`, `deltaAbsolute`, `deltaPercent`. In the chart as a second, paler line. Already noted as an open item in `documentation/utility-meters.md` §5.1. |
| C3 ✅ | **Weather adjustment of heating** | Heating consumption ÷ heating degree days of the month. Without it, "more heating electricity than last year" is usually just "colder winter". Implemented with both sources: degree-day series as an assumption (`heating_degree_days`, file import) or — without external data — a reference winter estimated from the own data, each time stated explicitly (`GET /meters/reports/heating-weather`, #1023). |
| C4 | **Outlier context** | In the trend chart, mark the buckets that are based on unusually long/short reading intervals (< 20 or > 40 days for monthly buckets). Prevents misinterpretations before stage 7 (anomalies) even exists. |

### D — Operation & system condition

| # | Report | Content |
|---|---|---|
| D1 | **kWh per compressor hour** | Heat pump electricity consumption ÷ compressor hours, over the years. A rising value = declining efficiency (icing, refrigerant loss, dirty heat exchanger). |
| D2 | **Runtime share & cycling** | Operating hours per pump per month as utilization in %; compressor hours per heating kWh as a cycling indicator. |
| D3 | **Water: base-load detector** | Smallest daily consumption of a month (derived from reading intervals). A rising floor at otherwise unchanged consumption is the classic signal for a running toilet cistern or a leak. |

### E — Costs & Finance

| # | Report | Content |
|---|---|---|
| E1 | **Costs per application** | Heating, hot water, wallbox, household each in € — PV share at the self-consumption value, grid share at the unit price. Directly answers "what does heating really cost me" and is the basis for B1/B2. |
| E2 | **Water costs** | Analogous to electricity with water/wastewater tariff (unit price per m³ + base fee). |
| E3 ✅ | **Advance payment vs. actual** | Advance payments made (Finance, linked via readings) against calculated actual costs → expected additional payment/refund before the annual statement. `GET /meters/reports/advance-payments` (#1018). |

---

## 3. Technical prerequisites

### 3.1 Report core (basis for almost everything above)

- **Interpolation onto bucket boundaries.** Distribute the consumption of a
  reading interval linearly onto the overlapping buckets instead of attributing it entirely
  to the start bucket. Affects `buildMeterReportBuckets`.
  Backward compatibility: as option `allocation=interval_start|interpolated`
  with `interpolated` as the new default, so that numbers change in an explainable way.
- **Previous-year comparison** (`compare=previous_year`) in `MeterReport` and
  `EnergyReport`.
- **Rolling 12-month sum + trend metrics in the backend**, instead of the
  regression in the frontend. Result per metric: `rolling12`, `slopePerYear`,
  `changeVsPreviousYear`, `dataPoints`.
- `granularity=day|week` — implemented (#1024): day buckets `YYYY-MM-DD`,
  ISO weeks `YYYY-Www`; not very informative for monthly manual readings,
  valuable as soon as the API ingestion delivers daily.

### 3.2 Assumption master data

B1/B2/B3 need dated assumptions (gas price, petrol price, JAZ,
boiler efficiency, kWh/100 km, l/100 km, kWp, grid mix). The existing
table `meter_electricity_tariffs` is already a generic
`(kind, valid_from, amount, unit)` store and, with
`pv_investment_*` / `expected_return_rate`, already contains non-tariff values.

**Recommendation:** Reuse the table and extend it with new `kind`s and `unit`s
(`eur_per_l`, `eur_per_m3`, `kwh_per_100km`, `l_per_100km`,
`ratio`, `kw`, `kg_per_kwh`), and present it in the UI as "Tarife & Annahmen"
(tariffs & assumptions) with two sections. This saves a migration plus a second CRUD; the price
is a table name that is somewhat broader in meaning.
The alternative would be a separate `meter_assumptions` table — named more cleanly,
but duplicated code for the same semantics.

Every model calculation returns the assumptions used in the response
(`assumptions: [{ kind, amount, unit, validFrom }]`), so that the UI can
display them and the number stays traceable.

### 3.3 Role fix (blocker for B2)

- Extend `IMPORT_METER_ROLES` with `e_auto_wallbox → ev_charger_total` and
  `e_auto_pv → ev_charger_pv`.
- Migration with backfill for already imported data (pattern: 0123).
- A test that ensures every role defined in `MeterRole` is actually
  assigned after the import — exactly this gap is otherwise invisible.

---

## 4. Proposed order

| Stage | Content | Why here |
|---|---|---|
| **6a** ✅ | Report core: interpolation, previous-year comparison, trend/rolling metrics in the backend + role fix | Foundation; without interpolation and seasonal adjustment all trend statements are unsound |
| **6b** ✅ | Trend dashboard (C1, C2, C4) in the frontend | The directly desired benefit, as soon as 6a is in place |
| **6c** ✅ | Cumulative PV savings + payback (A1, A2), costs per application (E1) | Uses only existing tariffs, no new assumptions |
| **6d** ✅ | Assumption master data + gas and petrol comparison (B1, B2), CO₂ (B3) | Needs 6c (costs per application) as comparison basis |
| **6e** ✅ | System condition (D1–D3), yield per kWp (A4), water costs (E2) | Nice-to-have, independent of each other |
| **6f** ✅ | Season profile (A3), weather adjustment (C3), day/week granularity | Follow-ups from #1022, #1023, #1024 |
| **8** ✅ | Finance link + advance-payment comparison (E3) | #1018 |

Each stage can be tested and deployed individually; `npm run test` before every push.

---

## 5. Decisions

Made:

1. **Interpolation is the new default** (`allocation=interpolated`), the
   Excel logic remains available as `allocation=interval_start`.
2. **Assumptions go into `meter_electricity_tariffs`** — the table is extended
   with new `kind`s and `unit`s instead of creating a second table
   (§3.2). Implemented in 6d.
3. **`granularity=day|week`** is implemented (#1024); ISO weeks, Monday
   to Sunday.
4. **Degree days** (C3) — the default is the automatic retrieval from the
   Open-Meteo archive (ERA5 daily mean for the stored home location, VDI 2067
   sum, daily backfill job); the series is stored as the assumption
   `heating_degree_days` (unit `kd`, one row per month) and can
   equally be maintained via file import or by hand — the retrieval never overwrites
   existing rows. If both are missing, the report estimates the
   reference winter from the own data and says so in the frontend.

Implemented as proposed: the **JAZ range** (± 0.5) instead of a
single value for B1.

Added after the model analysis (PR #1201, details in
`utility-meters.md` §5.1–§5.2.4):

5. **Sums only over complete buckets** (`complete`), rates from jointly
   available pairs, missing role → `null` instead of 0, data errors as
   `warnings` instead of being clipped, duplicate roles reported.
6. **PV share at the feed-in tariff** in both comparisons (instead of
   double valuation for the EV and zero valuation for the heat pump); CO₂ only
   via the grid share; assumptions and prices valid per bucket in time; sums only
   over the common bucket set; charging losses as an assumption.
7. **Payback** on measured months (`measuredMonths`), extrapolation
   only from twelve gapless months; investment as the sum of all entries;
   `heatPumpRest` as its own application.
8. **Regressions over calendar time** with a minimum number of points; previous year instead of
   first value for compressor and PV yield; PV yield always per calendar year
   against the median; water base load only with sufficiently dense readings;
   runtime share uncapped with an `implausible` marker.
9. **Water roles** `water_main`/`water_garden` (base fee once, garden
   without wastewater); feed-in tariff by generation and capacity tier;
   annual costs from months; plausibility limits when creating assumptions.

Added after recalculating the energy block by hand:

10. **Metrics cover the displayed window**: The tiles of the block
    "Energie" (energy) aggregate exactly the periods of the table below (12 months
    or all years) and within them only the completely read ones, instead of showing the
    `totals` of the report over the entire history. Rates come from
    the sums of the window, not from the mean of the monthly percentages, and the
    trend lies on the calendar axis. Behind each value stands its
    reference basis (`kWh / Monat`, `€ / 12 Monate`).

11. **Petrol prices automatic**: The dated assumption `petrol_price` is filled from
    the EU Weekly Oil Bulletin (monthly mean Euro-Super 95 including
    taxes, federal average), starting from the first month with a wallbox reading.
    This values every bucket with the price of its own months,
    without anyone having to maintain years of values by hand. Existing rows
    stay in place — the national average is a model assumption, not the
    price at one's own filling station.

12. **VAT in the payback**: The refunded input VAT
    (`pv_vat_refunded`) is deducted from the investment — money that was refunded
    does not have to be earned back. Conversely, the VAT on
    self-consumption (`self_consumption_vat_rate`, gratuitous
    withdrawal) reduces the PV benefit as long as regular taxation applies; a second
    row with 0 for the switch to the small-business scheme ends it without
    changing the years before.
