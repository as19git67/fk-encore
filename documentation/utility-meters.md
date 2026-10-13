# Meter Readings (Utility Meters) — Feature Plan

New module for recording and analyzing household meters (electricity, water,
gas) as well as operating-hours meters (pumps, compressors), including reading
by photo/OCR, automatic capture via API and linking to
finance transactions.

Status: Feature plan (GitHub Issue #792), stages 1–8 implemented (for the current state see §8).

---

## 1. Goals

- **Manage meters**: A meter has a name, type, location, unit, notes
  and optionally a photo. Creating/editing only with a special permission
  (admin page).
- **Model device replacement**: A meter (logical metering point) can be
  realized over time by several physical devices. On replacement
  the new device starts at 0 or at an arbitrary initial value. The **absolute
  total reading** of the metering point is the sum of the consumption of all devices and
  is monotonically increasing.
- **Record readings**: manually in a form, by photo with OCR recognition
  of the meter reading, or automatically via an external API (device/software
  pushes values). Date + time are always stored as well.
- **Analyses**: consumption over time, comparison with historical
  periods, anomaly detection (AI).
- **Finance link**: Payments (advance payments, annual statements) can be
  linked to readings or meters.

Non-goals (for now): tariff management/cost calculation per kWh, import from
utility portals, smart-meter protocols (SML/MQTT) — the API ingestion is
deliberately a generic HTTP endpoint; adapters for it can run externally.

---

## 2. Domain model

Central distinction: **metering point** (`meter`) vs. **physical device**
(`meter_device`).

```
meter (metering point, logical, permanent)
 └── meter_device (physical device, time-limited)
      └── meter_reading (reading of a device at a point in time)
```

Example from the issue (water):

| Device | from | to | Start value | End value |
|---|---|---|---|---|
| Device 1 | 2020-02-10 | 2025-03-21 | 102 | 734 |
| Device 2 | 2025-03-21 | — | 3 | (running) |

Absolute total reading today = (734 − 102) + (current reading − 3).
The end value of a device is the last reading before removal (on
"replace" it is recorded as a closing reading).

### 2.1 Tables (Drizzle, `db/schema.ts`)

```
meters
  id            serial PK
  name          text NOT NULL
  type          text NOT NULL  -- 'electricity' | 'water' | 'gas' | 'operating_hours'
  unit          text NOT NULL  -- 'kWh' | 'm3' | 'h' | free
  location      text
  notes         text
  photo_path    text           -- photo of the metering point (optional)
  decimals      integer NOT NULL DEFAULT 1  -- decimal places for input/display
  group_id      integer REFERENCES groups(id)  -- visibility analogous to documents (§4)
  owner_user_id integer NOT NULL REFERENCES users(id)
  created_at / updated_at timestamptz

meter_devices
  id            serial PK
  meter_id      integer NOT NULL REFERENCES meters(id) ON DELETE CASCADE
  serial_number text
  installed_at  timestamptz NOT NULL
  removed_at    timestamptz            -- NULL = active device
  start_value   numeric(14,3) NOT NULL -- reading at installation
  end_value     numeric(14,3)          -- reading at removal (NULL while active)
  notes         text
  -- Invariant: per meter_id at most one device with removed_at IS NULL
  -- (partial UNIQUE index)

meter_readings
  id            bigserial PK
  device_id     integer NOT NULL REFERENCES meter_devices(id) ON DELETE CASCADE
  value         numeric(14,3) NOT NULL
  taken_at      timestamptz NOT NULL
  source        text NOT NULL DEFAULT 'manual' -- 'manual' | 'ocr' | 'api'
  photo_path    text          -- receipt photo for OCR capture
  ocr_confidence real         -- 0..1, only for source='ocr'
  entered_by    integer REFERENCES users(id)   -- NULL for source='api'
  api_key_id    integer REFERENCES meter_api_keys(id) -- only for source='api'
  created_at    timestamptz NOT NULL DEFAULT now()
  UNIQUE (device_id, taken_at)

meter_api_keys
  id            serial PK
  meter_id      integer NOT NULL REFERENCES meters(id) ON DELETE CASCADE
  name          text NOT NULL          -- e.g. "Shelly EM Garage"
  key_hash      text NOT NULL          -- SHA-256 of the token, plaintext shown only once
  created_by    integer NOT NULL REFERENCES users(id)
  created_at    timestamptz
  last_used_at  timestamptz
  disabled_at   timestamptz

meter_reading_transactions          -- finance link, pattern like
  reading_id     bigint NOT NULL REFERENCES meter_readings(id) ON DELETE CASCADE
  transaction_id bigint NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE
  created_at     timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (reading_id, transaction_id)
```

Migration: next free number (`0121_utility_meters.sql`), **including an entry
in `db/migrations/postgres/meta/_journal.json`** (see CLAUDE.md).

### 2.2 Validation rules (service layer)

- New reading: `value >= start_value` of the device and `value >=` the last
  reading with `taken_at <=` the new timestamp (monotonic per device). Readings
  inserted retroactively must also be `<=` the next later reading.
  Violation → `APIError.invalidArgument` with details (expected minimum).
- Device replacement ("Replace"): atomic operation — closing reading +
  `end_value`/`removed_at` on the old device, new device with `installed_at` =
  `removed_at` and freely selectable `start_value` (default 0).
- Absolute reading: `SUM(COALESCE(end_value, last measured value) − start_value)`
  over all devices of the metering point; as an SQL view or query helper, not
  materialized.

---

## 3. Backend service `meter/`

New Encore service following the pattern of `documents/`:

```
meter/
├── encore.service.ts        // new Service("meter")
├── meter.service.ts         // DB logic (Drizzle)
├── meter.ts                 // CRUD endpoints for meters + devices
├── readings.ts              // readings (manual), history, absolute reading
├── readings-ocr.ts          // photo upload → OCR → suggested value
├── ingest.ts                // api.raw POST /api/meters/ingest (API-key auth)
├── api-keys.ts              // API key management
├── reports.ts               // consumption/time, period comparison
├── reports.service.ts       // generic bucket logic + DB report data
├── season-profile.service.ts   // season profile A3
├── heating-weather.service.ts  // weather adjustment C3
├── open-meteo-client.ts / degree-days.service.ts / home-location.ts  // degree days from the archive
├── anomalies.ts / anomalies.service.ts          // anomaly detection (job + endpoints)
├── reading-transactions.ts / .service.ts        // link reading ↔ finance_transaction
├── advance-payments.service.ts                  // advance-payment comparison E3
└── *.test.ts
```

### 3.1 Endpoints (all `expose: true, auth: true`, except ingest)

| Method/Path | Permission | Purpose |
|---|---|---|
| `GET /meters` | `meters.view` | List incl. current device, last reading, absolute reading |
| `POST /meters` / `PUT /meters/:id` / `DELETE /meters/:id` | `meters.manage` | Meter CRUD (admin page) |
| `POST /meters/:id/replace-device` | `meters.manage` | Device replacement (atomic, §2.2) |
| `PUT /meters/devices/:id` | `meters.manage` | Correct device data |
| `DELETE /meters/devices/:id` | `meters.manage` | Delete the newest device as long as it has no readings |
| `GET /meters/:id/readings` | `meters.view` | Readings (paginated, across device boundaries, with absolute-value column) |
| `POST /meters/:id/readings` | `meters.read_entry` | Manual reading |
| `PUT/DELETE /meters/readings/:id` | `meters.read_entry` (own) / `meters.manage` (others') | Correction/delete |
| `POST /meters/:id/readings/ocr` | `meters.read_entry` | Upload photo → `{ value, confidence, photoPath }` as a suggestion; saving only happens after confirmation via `POST readings` |
| `GET/POST/DELETE /meters/:id/api-keys` | `meters.manage` | API keys; plaintext token only in the create response |
| `POST /api/meters/ingest` | API key (no user auth) | External reading |
| `GET /meters/:id/report?granularity=day\|week\|month\|year&from=&to=` | `meters.view` | Generic consumption series (§5) |
| `GET /meters/reports/energy?granularity=day\|week\|month\|year&from=&to=` | `meters.view` | Electricity/PV overall report (§5.2) |
| `GET /meters/reports/season-profile?from=&to=` | `meters.view` | Season profile self-sufficiency/self-consumption (§5.2.5) |
| `GET /meters/reports/heating-weather?from=&to=` | `meters.view` | Weather-adjusted heating (§5.2.6) |
| `GET/PUT/DELETE /meters/home-location` | `meters.view` / `meters.manage` | Home location for the degree-day retrieval (§5.2.6) |
| `GET /meters/places?q=` | `meters.manage` | Place search (Open-Meteo geocoding) |
| `POST /meters/degree-days/fetch` | `meters.manage` | Fetch missing degree-day months from the Open-Meteo archive |
| `GET /meters/reports/advance-payments` | `meters.view` + `finance.view` | Advance payments vs. actual costs (§6.1) |
| `GET /meters/anomalies?status=pending\|all` | `meters.view` | Anomalies of visible meters (§5.3) |
| `POST /meters/anomalies/:id/status` | `meters.read_entry` | `confirmed` / `dismissed` / `pending` |
| `POST /meters/anomalies/run` | `meters.manage` | Run the anomaly check immediately (`reset` deletes open findings of the own meters) |
| `GET/POST/PUT/DELETE /meters/tariffs/electricity` | `meters.view` / `meters.manage` | Manage electricity prices and feed-in tariff (§5.2) |
| `POST /meters/tariffs/import` | `meters.manage` | Import price/assumption series from a file (§5.2.2) |
| `GET /meters/readings/:id/transactions` | `meters.view` + `finance.view` | Linked payments of a reading (Finance-ACL-filtered, §6) |
| `POST /meters/readings/:id/transactions` / `DELETE …/:transactionId` | `meters.read_entry` + `finance.view` | Link / unlink a payment (§6) |

### 3.2 External ingestion

`api.raw` endpoint (no Encore auth handler), authentication via
`Authorization: Bearer <token>`; lookup via `key_hash`. Payload:

```json
{ "value": 1234.5, "takenAt": "2026-07-09T06:00:00Z" }
```

- `takenAt` optional (default: server time); the API key is bound to exactly one
  meter, the target device is the active device of the metering point.
- Idempotency via `UNIQUE (device_id, taken_at)` — duplicate → 200 with
  `duplicate: true` (devices often send twice).
- Monotonicity violations → 422; rate limit like `user/rateLimiter.ts`.
- Update `last_used_at` on the key.

### 3.3 Photo OCR

Reuse of the existing ML infrastructure:

1. **Stage 1 (MVP)**: new endpoint `/meter-reading` in the
   `receipt-ocr-service` (PaddleOCR already runs there). Meter readings are
   printed/mechanical digits — PaddleOCR raw text + heuristic (longest
   plausible digit sequence, red decimal-place wheel optionally
   strippable). Returns `{ value, confidence, rawText }`.
2. **Stage 2 (fallback/quality)**: on low confidence, a vision prompt
   to the `llm-service` (analogous to `documents/llm-client.ts`) that extracts
   the value from the image.
3. The frontend **always** shows the recognized value for confirmation/correction —
   OCR never saves directly. The photo is stored under `METERS_DIR` (analogous to
   `DOCUMENTS_DIR`) and referenced on the reading.

---

## 4. Permissions & visibility

New permission keys in `db/seed.ts` (pattern like Documents/Finance):

| Key | Description |
|---|---|
| `module.meters` | Enable utility meters module (Navigation) |
| `meters.view` | View meters, readings and reports |
| `meters.read_entry` | Record readings (manual/OCR) |
| `meters.manage` | Create/edit/replace meters, manage API keys (special permission per the issue) |

Visibility: Meters belong to a user (`owner_user_id`) and optionally to
a group (`group_id`, existing `groups` concept from the
Documents module). A meter is visible to the owner + group members;
`meters.manage` only applies to visible meters (no global admin bypass
needed, household scope is enough).

---

## 5. Reports & anomaly detection

### 5.1 Consumption series

`GET /meters/:id/report?granularity=day|week|month|year&from=&to=`

- Consumption per bucket = difference between two consecutive
  absolute readings.
- **Allocation (`allocation`)**: The default is `interpolated` — a
  reading interval is distributed proportionally in time onto the buckets it
  overlaps. `interval_start` attributes the interval entirely to the bucket
  of its start time; this is the original Excel logic and is kept
  to reproduce old numbers.
- The calculation is generic for all meter types and runs over the
  absolute reading of the metering point, i.e. also across device replacements.
- `from`/`to` filter whole buckets by period start in both allocations —
  only after the previous-year comparison, so that a filter does not remove the
  reference period.
- **Device replacement**: the absolute reading runs across all devices of the metering point.
  If a replaced device has no `end_value`, its last reading counts as
  the final reading (`buildDeviceOffsets` in `meter.service.ts`, shared by reports,
  anomaly detection and the reading list).
- Two readings at the same point in time (e.g. device replacement) form an
  interval of length 0; its consumption is attributed entirely to the bucket of the
  point in time instead of being lost.
- `startValue`/`endValue` of a bucket are the readings interpolated onto the period boundaries,
  not the nearest readings — otherwise
  "end − start" would not match the reported consumption.
- **`coverage`** per bucket (0..1) states which share of the period is
  actually covered by readings. From `COMPLETE_COVERAGE_THRESHOLD`
  (0.99) a period counts as completely measured; below that it is a
  partial period and enters neither the previous-year comparison nor the trends.
  The frontend marks such periods.
- **`meanIntervalDays`**: coverage-weighted mean length of the
  reading intervals behind the bucket. A month from a single annual
  reading has `coverage` 1, but a mean interval of 365 days
  — the value is distributed, not measured. The detail view marks buckets
  whose mean interval is more than twice the period
  (`isInterpolatedPeriod`).
- **Previous-year comparison**: every bucket carries `previousConsumption`,
  `deltaAbsolute` and `deltaPercent` for the same period one year earlier —
  only if both periods are completely measured. `deltaPercent`
  compares the **daily rates**, not the sums: a leap-year February or
  a 53-week year is not a change in consumption.
- Identical for operating-hours meters (unit h).
- **`day`/`week`** (#1024): Day buckets carry the key `YYYY-MM-DD`,
  week buckets the ISO week `YYYY-Www` (Monday to Sunday, week-year
  per ISO 8601 — the days around the turn of the year belong to the week, not to the
  calendar year). Interpolation, coverage and previous-year comparison work
  unchanged; the previous year for a day is the same date, for a week the same
  week number of the previous year (a week 53 then finds no partner). All
  bucket helpers (`bucketKey`, `bucketStartDate`, `nextBucketStart`,
  `previousYearKey`, `bucketsPerYear`) are exported from `reports.service.ts`
  and reused by the other report services.
  This only becomes useful with regular API ingestion; the detail view
  offers the four levels as a toggle and shows the last 31 periods for the day,
  the last 26 for the week.

### 5.1.1 Consumption trends

`GET /meters/reports/trends`

Answers "do I tend to consume more or less?" per category:
household electricity (without heat pump and wallbox), heating, hot water,
EV/wallbox, grid import, and one entry per visible water/gas meter.

All metrics run over the **rolling 12-month sum**, not over
raw monthly values — otherwise a regression over twelve months mostly measures
the season. Delivered per metric: `current12` (last twelve completely
measured months), `previous12` (the twelve before), `changeAbsolute`,
`changePercent`, `slopePerYear` (regression over the rolling series),
`trendPoints` (number of rolling values behind the regression), `direction`
(`rising`/`falling`/`stable`/`unknown`) and `directionBasis`
(`year_over_year` / `regression` / `none`). Changes below 2 % count as
`stable`. A gap in the readings makes every rolling window that contains it
`null` — a missing month must not look like a decline.

The regression needs at least `MIN_SLOPE_POINTS` (6) rolling values, i.e. 17
months of data: consecutive rolling windows overlap by eleven twelfths,
three of them are almost a single observation. With fewer points the
direction stays `unknown` instead of asserting a tendency from three overlapping values.
If a full previous year is available, it is the basis of the direction; the
regression only applies behind it (`directionBasis`), and the frontend says so.

The regression helpers (`linearRegressionSlopeOverTime`, `yearsAt`) are
exported and compute over **calendar time**, not over list positions —
a measurement gap of one year must not double the slope. System condition
(§5.2.3) and weather adjustment (§5.2.6) use the same ones.

Role meters (water main connection/garden, gas) get exactly one tile:
a meter that already appears in the report via its role does not show up a second time in the loop
over the individual meters.

### 5.2 Electricity/PV overall report

`GET /meters/reports/energy?granularity=month|year&from=&to=`

The aggregated energy report combines the existing electricity meters, provided
they are visible. For this, explicit meter roles on `meters.role` are
used; the report logic does not derive roles from display names.
The historical electricity import sets these roles directly:

- `grid_import` → grid import
- `grid_export` → feed-in
- `pv_production` → production
- `heat_pump_total` → heat pump overall
- `heat_heating_total` / `heat_heating_pv` → heating/underfloor heating overall and PV share respectively
- `hot_water_total` / `hot_water_pv` → hot water overall and PV share respectively
- `ev_charger_total` / `ev_charger_pv` → EV/wallbox overall and PV share respectively

From these, the following values are computed per bucket and for the total:

- Self-consumption = production - feed-in
- Total consumption = grid import + self-consumption
- Self-sufficiency = 1 - grid import / total consumption
- Self-consumption rate = self-consumption / production
- Consumption without heat pump/EV = total consumption - heat pump overall - EV/wallbox overall
- Heating PV share = heating PV / heating overall
- Hot water PV share = hot water PV / hot water overall
- EV/wallbox PV share = EV/wallbox PV / EV/wallbox overall
- Grid import costs = grid import × time-valid unit price
- Base costs = time-valid base price pro rata per bucket
- Feed-in revenue = feed-in × time-valid feed-in tariff
- Avoided grid import = self-consumption × time-valid self-consumption value
  (fallback: unit price for grid import)
- PV benefit = avoided grid import + feed-in revenue
- Net electricity costs = grid import costs + base costs - feed-in revenue

Periods without a complete PV set (grid import, feed-in and production) are
omitted from the aggregated energy report, so that old pre-PV data does not flow into
PV metrics and analysis values. Migration `0123_meter_roles`
backfills already imported historical meters once; the report role can be set
when creating/editing manually.

Rules that follow from the analysis of the reports (PR #1201):

- **`complete`** per bucket: PV set complete **and** every participating meter
  above `COMPLETE_COVERAGE_THRESHOLD`. Only complete buckets enter
  `totals`; incomplete ones are still delivered and marked in the
  frontend. The sums for self-consumption and total consumption are sums of the
  bucket values, the rates (self-sufficiency, self-consumption rate, PV shares) are formed from the
  sums of the pairs available **jointly** in each case, not from
  sums over different bucket sets.
- **Missing role → `null`**, not 0: "consumption without heat pump/EV"
  is only defined if the meters to be subtracted exist. If
  `heat_pump_total` is missing, the sum of the existing sub-meters is subtracted.
- **`warnings`** per bucket (`export_exceeds_production`,
  `exclusion_exceeds_total`) make data errors visible instead of clipping
  them: more feed-in than production usually means "read on different
  days", heat pump + wallbox above total consumption means "a
  sub-meter is not connected to the grid import". PV shares are capped at 1.
- **`duplicateRoles`**: if several visible meters carry the same role, only
  the first one is used (`resolveRoleMeters`), and the report says so —
  previously the respective random match was silently used.
- **Annual costs** are summed from the monthly buckets (`sumCostResults`),
  not computed from the annual bucket: a price change in the middle of the year is
  thus weighted to the day, and the base price is split at price changes
  within a month. Without a base-price entry 0 applies, not
  "costs unknown".
- **Feed-in tariff**: the entry is the most recent *generation* at that point in time
  (`valid_from` ≤ point in time) and within it the capacity tier ≥
  `pv_capacity_kwp` (fallback: smallest tier). The tariff at
  commissioning applies for 20 years — a generation stored later for an
  extension does not override it retroactively.
- **Time-valid assumptions** (`amountAt(kind, at)`): a value with `valid_from`
  in the future does not apply backwards, but the earliest entry also applies
  before its `valid_from` (prices existed already). On creation,
  `assertTariff` checks plausibility limits per kind (`AMOUNT_BOUNDS`: JAZ 1–8,
  boiler efficiency 0.3–1.2, charging losses 0–0.5, return 0–0.3 etc.), so that
  a typo (JAZ 35) does not appear as a result.

Costs and PV savings use `meter_electricity_tariffs`. The
tariff management allows price changes with `valid_from` for:

- `grid_import` unit price for grid import (`eur_per_kwh`)
- `base_price` base price (`eur_per_month`)
- `feed_in` feed-in tariff (`eur_per_kwh`)
- `self_consumption_value` assumed value of self-consumption (`eur_per_kwh`)

In addition, imported assumptions such as PV investment, opportunity costs and
payback years can be stored. They are currently not yet included in the
bucket costs, but remain available as master data.

Historical price series come via the file import `POST /meters/tariffs/import`
(§5.2.2). The former built-in price basis and the one-off
history imports for water and electricity are removed: they contained private
meter data. Several capacity tiers can be stored for the feed-in tariff,
but there is no system capacity in the Encore model yet. Until a system-capacity setting exists, the
cost calculation uses the lowest matching tier.

Not part of the first expansion stage: EV, gas comparison/JAZ.

**Metrics in the frontend block "Energie"** (`frontend/src/utils/energySummary.ts`):
The report delivers `totals` over *all* complete periods since the start of
recording. The block, however, only shows a window — in the monthly view the
last 12 months, in the yearly view all years. The tiles therefore do not
compute with `totals`, but aggregate exactly the buckets of this window, and
within it only those with `complete === true`; the current month or the current year
is additionally excluded. Otherwise "Sum in the displayed period" would stand above the costs,
while the number spans ten years, and the average cannot be
recomputed from the table below.

In the same module:

- **Rates from sums**: Ø self-sufficiency, Ø self-consumption rate and the PV shares
  come from the sums of the window (`1 − Σ grid import / Σ total consumption`), not
  from the mean of the monthly percentages — otherwise a low-consumption month counts as
  much as a high-consumption one. A PV share is only formed over periods
  in which *both* sides are known.
- **Trend over the calendar axis** (`slopePerPeriod`): The data points are
  `periodOrdinal` (year × 12 + month), not the index in the array. A missing
  month thus remains a gap instead of being silently closed.
- **Reference basis on the value**: An average is output as `kWh / Monat` or
  `kWh / Jahr`, a sum as `€ / 12 Monate` or `€ / 5 Jahre`
  (`periodUnit`, `periodSpanLabel`). The number alone does not say what it
  refers to.

### 5.2.1 Profitability

`GET /meters/reports/economics?granularity=month|year&from=&to=`

Two blocks that the kWh reports cannot answer:

**PV savings and payback.** Per bucket `netElectricityCostEur` (with PV,
actual) against `noPvElectricityCostEur` (the same consumption quantity bought entirely
from the grid); the difference is `savingsEur`, cumulated in
`cumulativeSavingsEur`. The sums (`totalSavingsEur` etc.) run, as in the
energy report, only over `complete` buckets. The payback compares the
investment (sum of all `pv_investment_net` and `pv_investment_vat`
entries up to today **minus `pv_vat_refunded`**, an extension is a
second entry) with the PV benefit cumulated over the
**entire** measured history — independent of `from`/`to`, because the question is what the system
has brought in since commissioning. `measuredMonths` are the completely measured months
behind it, `yearsElapsed` = `measuredMonths` / 12 is the common time basis
of benefit and opportunity costs — a measurement gap thus does not extend the
interest calculation. The extrapolation of the payback date uses
`benefitLast12MonthsEur`, the benefit of the last twelve **gaplessly**
measured months; if there is a gap in the last twelve months, it stays
`null` and deliberately no date is given.

The opportunity costs are **not master data** but are computed.
The only assumption is `expected_return_rate` — the return that the money
would presumably have earned elsewhere (factor, 0.05 = 5 %/year). From it
follows the forgone yield as a **fixed annual amount** (investment × rate,
simple interest, not compound interest) — the same form as the formula of the
original table (`=B15*0.05`), only from the rate instead of stored as a result cell.
Compound interest was deliberately rejected: an exponentially growing
"what would the system have earned elsewhere" curve against an approximately
constant annual PV benefit overtakes the latter at any positive rate
irrecoverably at some point — the payback date would have been "unreachable"
for practically every real system, which is mathematically correct, but
no useful statement about the system. With the fixed annual amount
the condition is simple again: the date is reachable as soon as the
annual benefit (last 12 months) is above the annual opportunity costs;
otherwise deliberately **no** date is delivered instead of a flattering one.

**VAT that was never left paid.** Under regular taxation, the
household reclaims the input VAT on the system from the tax office — this money does not have to
be earned back. `pv_vat_refunded` (€, one row per investment)
records what was refunded, and the investment is
`net + VAT − refunded`. More than the booked VAT is never deducted:
only what was paid beforehand comes back, anything above that is a typo.
Without an entry the investment stays gross — whoever has not opted in actually pays the
VAT.

The counterpart is the **gratuitous withdrawal** (unentgeltliche Wertabgabe): As long as
regular taxation applies, the household owes VAT on the electricity it
consumes itself. `self_consumption_vat_rate` (factor, e.g. 0.19) is evaluated per
bucket in a time-valid way and applied to the value of the self-consumption
(`self_consumption_value`, according to the source exactly the tax base); the
result appears as `selfConsumptionVatEur` in the cost result and is deducted from the
PV benefit. The switch to the small-business scheme after five years is
a **second row with 0** on the date of the switch — the years before keep their
tax, those after are free of it. Without an entry nothing is deducted.

The feed-in tariff is stored in the imported data already **net**
(`tax_status` `net`), the grid import **gross** — both fit
regular taxation, in which the VAT on the feed-in is a
pass-through item. `tax_status` is documentation of the source and
is not evaluated by any calculation; what has a tax effect are the two
assumptions above.

**Costs per application.** Heating, hot water, heat pump (remainder),
EV/wallbox and the rest of the household each in €. Self-consumed kWh
are valued at `self_consumption_value`, grid import at the time-valid
unit price; `gridKwh` is always set and the PV share never larger than
the total consumption of the application. **`heatPumpRest`** is the part of the
"heat pump overall" meter that the heating and hot water sub-meters do not
cover (or the whole pump if there are no sub-meters) — previously
it was missing from every application and the household was too large. Its PV share is
not measured, it counts at the grid price. The PV share of the household is the
remainder of the total self-consumption quantity that no sub-meter claims
(capped at the household consumption). The base price is not assigned to any application;
`totalCostEur` is applications + base price. The application sums
are a **comparison value** (grid import at the unit price plus self-consumption
at the self-consumption value), not the electricity bill — the frontend says so
below the table.

If prices are missing (`hasTariffs === false`), both blocks stay empty instead of
calculating with placeholder values.

### 5.2.2 Comparison calculations (gas heating / petrol car)

`GET /meters/reports/comparisons?granularity=month|year&from=&to=`

Counterfactual model calculations — only the electricity side is measured, the
counter-calculation is based on assumptions. Every response therefore delivers the
assumptions used (`assumptions`), so that the frontend can display them
and the number remains assessable.

**Valuation of the electricity** (same for both comparisons): the grid share at the
time-valid unit price, the PV share at the time-valid
**feed-in tariff** — this is what these kWh would have earned instead
(fallback: self-consumption value, then unit price). The earlier version
valued the PV share for the EV twice (self-consumption value *plus*
forgone feed-in) and for the heat pump not at all; now the same
opportunity logic applies to both.

**Heat pump instead of gas heating.** Heat quantity = heat pump electricity [kWh el.] ×
JAZ; gas demand = heat quantity ÷ boiler efficiency; gas costs = gas demand ×
gas price + gas base price. The heat pump electricity comes from the sub-meters
heating + hot water (`heatSource: sub_meters`); if they are missing, from
`heat_pump_total` (without PV split, everything at the grid price) or from the
one existing sub-meter (`heating_only` / `hot_water_only`) — the
report names the source, the frontend explains the limitation.

Without a heat meter the JAZ is estimated. The result is therefore shown as a
**range** over JAZ ± `SCOP_BAND` (0.5), not as a single number.
A lower JAZ means less delivered heat and thus less gas —
the range is ordered by JAZ, the cost values follow it.

**EV instead of petrol car.** km = wallbox kWh × (1 − `ev_charging_loss`) ÷
consumption [kWh/100 km] × 100; petrol demand = km ÷ 100 × [l/100 km];
petrol costs = liters × petrol price. The wallbox counts more than arrives in the
battery; without stored charging losses (assumption `ev_charging_loss`,
factor 0–0.5) 0 applies and the frontend points out that the kilometers
are then more likely overestimated. `evCostEur` is the valuation of the charging
electricity described above and the basis for the difference and ct/km.

**Common bucket set.** Only buckets in which *both* sides are known
(`compared`) enter the sums, ct/km, CO₂ and the reported period
(`periodStart`/`periodEnd`, `comparedPeriods`) — otherwise 24 months of
electricity costs would stand against 18 months of petrol price. Incompletely measured buckets
(§5.2 `complete`) are removed beforehand.

**Time-valid assumptions.** Each bucket calculates with the value that applied at its
start (`amountAt`): JAZ, consumption, emission factors, prices. The
`assumptions` therefore contain, per kind, all entries effective in the period
with `validFrom` (`entriesForPeriod`), including unit price,
feed-in tariff and self-consumption value; the frontend shows a series as
"x ab MM.JJJJ, y ab MM.JJJJ" (x from MM.YYYY, y from MM.YYYY).

**CO₂** is only calculated if the emission factors are stored,
and with the **grid share** of the electricity — PV electricity has no grid-mix factor.
If the grid factor is missing, CO₂ stays `null`. For the heat pump the
avoided quantity depends on the JAZ and is therefore delivered like the costs as a range
(`avoidedCo2Range`; `avoidedCo2Kg` is the mean).

If the core assumptions of a comparison calculation are missing (JAZ + boiler efficiency
or EV consumption + petrol consumption), it returns `null` instead of calculating with
default values.

#### Assumptions as master data

The assumptions live in `meter_electricity_tariffs` (migration 0148). They are
not measured tariffs, but have the same form
(`kind`, `valid_from`, `amount`, `unit`) and the same "which value applied
when" logic — a second table with duplicated CRUD would be pure overhead.

| kind | Unit | Meaning |
|---|---|---|
| `gas_price` | `eur_per_kwh` | Gas unit price |
| `gas_base_price` | `eur_per_month` | Gas base price |
| `boiler_efficiency` | `ratio` | Boiler efficiency |
| `heat_pump_scop` | `ratio` | Seasonal performance factor (JAZ) |
| `ev_consumption` | `kwh_per_100km` | EV consumption (from the battery) |
| `ev_charging_loss` | `ratio` | Charging losses between wallbox and battery (migration 0194) |
| `petrol_consumption` | `l_per_100km` | Petrol car consumption |
| `petrol_price` | `eur_per_l` | Petrol price |
| `grid_co2` / `gas_co2` | `kg_per_kwh` | Emission factors |
| `petrol_co2` | `kg_per_l` | Emission factor petrol |

Prices with a time profile (gas, petrol) are weighted pro rata in time over price changes,
like the electricity unit price.

For every kind there is an explanation understandable to laypeople
(`ELECTRICITY_TARIFF_KIND_EXPLANATIONS` in `frontend/src/api/meters.ts`), which
appears in the dialog below the kind selection as soon as the respective kind is selected
— reactive to `tariffForm.kind`, no separate legend needed.

#### File import of series

`POST /meters/tariffs/import` (`meters.manage`) accepts a whole series at
once — intended for historical price curves such as petrol or
gas prices that run monthly over years and would be unreasonable to enter row by row in the dialog.
In the dialog "Tarife & Annahmen" (tariffs & assumptions) the button
**Datei importieren** (import file) is attached to it.

The format is JSON, either as `{ "entries": [...] }` or as a bare list:

```json
{
  "version": 1,
  "entries": [
    {
      "kind": "petrol_price",
      "validFrom": "2021-11-01",
      "amount": 1.68,
      "unit": "eur_per_l",
      "taxStatus": "gross",
      "source": { "reference": "ADAC Kraftstoffpreisentwicklung" }
    }
  ]
}
```

`kind` and `unit` are deliberately typed as free strings in the request and
are checked per row: typed as a union, a single typo would make the
entire file fail at the gateway instead of naming the faulty row. The import is **idempotent** via the same natural key
as the unique index (`kind`, `valid_from`, `unit`, `name`) — an already
existing row is updated, not duplicated, so a corrected file
may be imported again. Faulty rows do not stop the rest,
but come back with their position in `errors` (pattern:
`finance/data-import.ts`).

#### 5.2.2.1 Petrol prices from the EU Oil Bulletin

```
POST /meters/petrol-prices/fetch    (meters.manage)
POST /internal/meters/petrol-prices (job, daily 08:00 UTC)
```

The comparison calculation values every bucket with the `petrol_price` that applied in
**its** months (`weightedAmountForPeriod`, pro rata per day). That is the
whole point of the dated series — fuel cost two euros in 2022 and one euro
twenty in 2016; a single current price rewrites history. But nobody
maintains years of monthly values by hand, so
`fuel-prices.service.ts` fetches them, analogous to the degree days:

- **Source**: EU Weekly Oil Bulletin of the Commission (DG ENER), the
  history workbook with weekly values per member state going back to 2005.
  Column `DE_price_with_tax_euro95`, Euro-Super 95 including all taxes and
  levies, quoted in **EUR per 1000 liters**. No key needed; host in the
  network policy: `energy.ec.europa.eu`.
- **Link instead of UUID**: The download URL carries a UUID that changes on
  re-upload. The client therefore reads the link from the
  bulletin page (`findHistoryWorkbookUrl`) instead of hard-wiring it.
- **Plausibility band** 0.20–5.00 €/l after conversion: If the source
  ever changes the unit, the values end up far off and are
  discarded instead of being written as a price.
- **Monthly mean** from the weekly values, at least `MIN_WEEKS_PER_MONTH` (3)
  surveyed weeks. The current month is thus automatically excluded, and half a
  month is not output as a monthly mean.
- **Range**: from the month of the first reading of the meter with role
  `ev_charger_total` — before that there is nothing to compare — up to the last
  completely published month. Without a wallbox meter nothing happens, and
  the bulletin is then not fetched either.
- **Existing rows stay untouched**, as with the degree days. The
  federal average is a model assumption, not the price at this household's
  filling station — a manual correction must survive the retrieval.
- **One download per run**: The job loads the workbook once and passes the same
  monthly series on to every household (`loadMonthlyFuelPrices`) instead of pulling it
  anew per user.
- `source` per row records where the value comes from (`eu-weekly-oil-bulletin`,
  country, fuel, number of weeks, retrieval time).

Outages at the Commission come back as `unavailable`, not as an internal
error; the job logs them and runs again the next day.

### 5.2.3 System condition

`GET /meters/reports/equipment?granularity=month|year&from=&to=`

Early indicators that get lost in the consumption sums:

- **kWh per compressor hour** — heat pump electricity ÷ compressor operating hours.
  A rising value means: more electricity for the same running hour (icing,
  refrigerant loss, dirty heat exchanger). Needs the role
  `compressor_hours` (migration 0149, the import sets it for "Verdichter" (compressor)).
  The ratio is only formed if **both** sides are completely measured
  — otherwise a full month of electricity would stand against half a month of hours —
  and if the compressor ran at least `MIN_COMPRESSOR_RUNTIME_SHARE` (3 %) of the
  period: in summer the quotient measures standby and start-ups, not the
  pump. `changePercent` compares the last period with the **same period
  one year earlier** (`previousYearKwhPerHour`, `latestKey`), never a January
  with a July; `slopePerYear` is a regression over calendar time.
- **Runtime share** per unit — operating hours ÷ measured time of the
  period. It is measured against the time actually covered
  (`coverage`), otherwise a half-read month would look half as utilized.
  The share is **not** capped at 100 %: more hours than the period
  has are a reading error that the reader should see (`implausible`). The
  average is weighted by period length.
- **Water base load** — the *smallest* daily consumption of a period. If
  this floor rises at constant total consumption, that is the classic
  signature of a running toilet cistern or a leak. Computed from the raw
  reading intervals, **not** from the interpolated buckets: a minimum
  cannot be interpolated, distributing would blur exactly the quiet phase
  that makes the leak visible. Each interval counts toward the period
  of its start time; `from`/`to` filter by this start time.
  A minimum only exists if the period has at least two intervals or
  the shortest is at most `MAX_BASELINE_INTERVAL_DAYS` (7) long — with
  one reading per month the minimum is the average and says nothing
  (`minDailyRate` `null`, `tooSparse` if this applies to all periods).
  Only periods whose intervals cover at least half of the period
  (`measuredDays`) are compared (`latestKey`, previous year, regression).
- **Yield per kWp** — annual yield ÷ system capacity (`pv_capacity_kwp`).
  Normalizes out the weather year and is thus the only reliable
  early indicator of degradation or dirty modules. Always per
  **calendar year**, independent of the report granularity — a December
  against a July is weather, not degradation. For each year the capacity installed
  at that time applies (`timeline.amountAt("pv_capacity_kwp", …)`,
  `capacityKwp` in the bucket), so that an extension does not
  appear as a yield jump. It is compared with the previous year (`changeVsPreviousYearPercent`)
  and with the **median of the other years** (`changeVsMedianPercent`) — the
  best year is by definition the luckiest weather, against which every
  normal year looks like decline (`bestYieldPerKwp` remains as additional info).
  Partial periods are left out, otherwise a measurement gap would look like
  degradation.

The report returns `missingRoles` (heat pump overall, PV production,
compressor) and `duplicateRoles`, loads each meter report per granularity only
once and the sub-reports in parallel.

### 5.2.4 Water costs

Part of the profitability report (§5.2.1) as `water[]`, one entry per
visible water meter. Fresh water and wastewater are both calculated on the measured
quantity (`water_price`, `sewage_price`), the base fee
(`water_base_price`) pro rata across month boundaries. Without water tariffs (even
just a base fee) the list stays empty.

Roles (migration 0194): **`water_main`** is the house connection and carries the
base fee — if the role is missing, it is the first water meter without a garden role.
**`water_garden`** is a garden water meter: no wastewater fee (the
water does not end up in the sewer) and no base fee. Previously every
water meter got both, and a household with two meters paid the base fee
twice on paper.

### 5.2.5 Season profile self-sufficiency/self-consumption (A3, #1022)

`GET /meters/reports/season-profile?from=&to=`

Heatmap year × month for self-sufficiency and self-consumption rate. No new
data: `season-profile.service.ts` pivots the monthly buckets of the
energy report into a grid per metric (`years[].months[0..11]`), adds
row (`average`) and column means (`monthAverages`) as well as `min`/`max`.
Only completely measured months (`coverage ≥ 0.99`) fill a cell —
a half month would have a distorted rate. Frontend:
`MeterSeasonProfilePanel.vue`, color scale fixed at 0..100 % (not min/max), so that
a system with 40 % self-sufficiency also looks pale.

### 5.2.6 Weather-adjusted heating (C3, #1023)

`GET /meters/reports/heating-weather?from=&to=`

"More heating electricity than last year" is usually just "colder winter". The
report divides the monthly heating consumption (role `heat_heating_total`,
fallback `heat_pump_total`) by the degree days of the month; the remainder —
kWh per degree day — describes the house and heating instead of the weather.

The open decision no. 4 (`documentation/utility-meters-reports.md` §5) is
resolved such that **both** options exist and the report states the source
used (`source`):

- **`degree_days`** — degree days as an assumption series in
  `meter_electricity_tariffs`: `kind = heating_degree_days`, `unit = kd`
  (Kelvin days), one row per month with `valid_from` = first of the month
  (migration 0192). The standard route is the **automatic retrieval** from the
  Open-Meteo archive (see below); alternatively a VDI 2067 series of a
  nearby station via the file import. Per month, `kwhPerDegreeDay` and
  `adjustedKwh` result (consumption normalized to a
  *normal month*: kWh/Kd × multi-year mean of the degree days of this
  calendar month). Annual values are the ratio of the sums, not the
  mean of the monthly quotients — summer months with a handful of degree days
  would otherwise dominate. `changePercent` compares the kWh/Kd of the last
  complete year with the year before, `slopePerYear` is the
  regression over it.
- **`estimated`** — without degree-day rows the reference winter is estimated from the
  own data: the multi-year mean of each calendar month
  (at least two years, otherwise `null`). This cannot remove the weather,
  but honestly shows the deviation from the household's own
  normal month (`deviationPercent`). The frontend names the mode and
  points to the import.

Frontend: `MeterHeatingWeatherPanel.vue` (tiles kWh/Kd current/previous year/
change, annual and monthly table, below it the home-location card). The
terms are explained by `MeterDegreeDaysHelpView.vue` (route `zaehler-hilfe-gradtage`),
linked via "Was sind Gradtage?" (what are degree days?) in the panel heading: definition and
unit Kd, why kWh/Kd removes the weather, the three sources of the
numbers, reading aid for normal month/typical/deviation as well as the G20/15 convention
and its limits.

#### Degree days from the Open-Meteo archive

`meter/open-meteo-client.ts`, `meter/degree-days.service.ts`,
`meter/home-location.ts` — so that nobody has to import a table:

- **Home location** (`meter_home_locations`, migration 0193, one entry per
  user): `label`, `lat`, `lon`, `source = geocoded | manual`. As in the trip planner, the
  coordinate is stored rounded to the 0.05° grid (≈ 5 km) —
  the reanalysis does not resolve more than that anyway, and
  more does not leave the house. Endpoints `GET/PUT/DELETE
  /meters/home-location` (`meters.view` / `meters.manage`).
- **Place search** `GET /meters/places?q=` (`meters.manage`) via
  `geocoding-api.open-meteo.com` (city/municipality, no key). If the
  search is down, coordinates can be entered directly (`source = manual`).
- **Retrieval** `archive-api.open-meteo.com/v1/archive`, `daily =
  temperature_2m_mean`, time zone of the place (`timezone=auto`), ERA5 reanalysis
  from 1940, about five days behind today (`ARCHIVE_LAG_DAYS = 7`).
  Degree days per VDI 2067: heating day at daily mean < 15 °C, contribution
  20 °C − daily mean, summed monthly. A month with more than two
  missing days is not written — a gap must not look like a
  mild month.
- **Backfill** (`fillDegreeDaysForUser`): from the month of the first reading
  of the heating meter to the last completed, archived month;
  only missing months, one archive call per calendar year with a gap. Already
  existing rows (import, manual entry, earlier retrieval) stay
  untouched, the written ones carry `source.provider =
  "open-meteo-archive"`. Idempotent.
- **Job** `meter-degree-days`, daily 04:00 UTC for all users with a
  home location (a no-op as long as no new month is in the archive); manually
  via `POST /meters/degree-days/fetch` ("Gradtagzahlen abrufen" (fetch degree days) in the
  home-location card, `meters.manage`). Outages of the service are reported as
  `unavailable`, not as an internal error.
- **Network policy**: `archive-api.open-meteo.com` and
  `geocoding-api.open-meteo.com` must be reachable.

### 5.3 Anomaly detection (stage 7, #1015)

Implemented in `meter/anomalies.service.ts` (pure detector + job) and
`meter/anomalies.ts` (endpoints + job registration), pattern of
`finance/anomaly-detector.ts`:

- **Job** `meter-anomaly-detection`, daily 10:30 UTC via
  `lib/local-cron` (the meter service now calls `startLocalCron()`), manually
  via `POST /meters/anomalies/run`. Per metering point it loads the absolute
  reading series (across device replacements) and only evaluates intervals that end
  within the last `ANOMALY_RECENCY_DAYS` (60) — older intervals
  only feed baseline and season reference.
- **Baseline**: weighted mean and standard deviation of the daily rate of the
  up to 12 preceding intervals (at least 4), weighted by
  interval length. The standard deviation has a floor of 10 % of the
  mean — twelve nearly identical monthly readings would otherwise turn every
  fluctuation into a five-sigma event.
- **Seasonality**: rate of the same period one year earlier (pro rata in time
  over the intervals back then). If the current rate lies within
  ±25 % of it, the deviation is seasonal and is not reported.
- **Types**: `consumption_spike` / `consumption_drop` (|z| ≥ 3 and at least
  ±50 % versus the baseline), `standstill` (operating-hours meter without
  progress over ≥ 7 days although it usually runs),
  `negative_consumption` (absolute reading decreasing — the device validation
  catches this within a device, not across a wrongly
  configured device replacement).
- **Table `meter_anomalies`** (migration 0191): status
  `pending → confirmed | dismissed`, `score` (z-score), interval boundaries,
  `reading_id` of the closing reading, `details` (rate, baseline,
  seasonal rate, days, values). `UNIQUE (meter_id, type, interval_end)` makes
  the daily run idempotent; open findings in the window that are not
  detected again (the reading was corrected) are withdrawn by the run —
  confirmed or dismissed ones remain.
- **Frontend**: `MeterAnomaliesView.vue` (route `zaehler-anomalien`,
  menu entry "Auffälligkeiten" (anomalies) with badge from `stores/meterAnomalies.ts`),
  confirm/dismiss/reopen, filter by type and status,
  "Jetzt prüfen" (check now) with `meters.manage`.
- Optional LLM assessment (explanatory text) remains a later expansion stage.

---

## 6. Finance link (stage 8, #1018)

- Link table `meter_reading_transactions` (§2.1), pattern
  `finance_transaction_document`. Endpoints in
  `meter/reading-transactions.ts`, logic in
  `reading-transactions.service.ts`: The reading must belong to a visible
  meter, the transaction must be readable under the finance ACL
  (`finance_account_access`, `finance.admin` bypasses it). Linking is
  idempotent; the list hides transactions that the caller may not (or no longer)
  read.
- `GET /meters/:id/readings` returns per reading `linkedTransactions`
  (count), so that the table shows the state without an extra query.
- UI: column "Zahlung" (payment) in the readings table (only with `finance.view`) →
  `MeterReadingTransactionsDialog.vue`: linked bookings (unlink with
  `meters.read_entry`) and the existing finance search; without a search term
  the bookings ±45 days around the reading are offered.
- Match suggestions (score from date/recipient like
  `finance/document-matcher.ts`) remain a later stage — initially purely
  manual linking.

### 6.1 Advance payments vs. actual costs (report E3)

`GET /meters/reports/advance-payments` (`meters.view` + `finance.view`),
`meter/advance-payments.service.ts`, panel `MeterAdvancePaymentsPanel.vue`.

Per meter with linked payments and calendar year: `paidEur` = Σ −amount
of the linked bookings of the year (payments are negative bookings; a
refund booked positively reduces the sum), `actualCostEur` = for
electricity meters the net electricity costs of the energy report (annual bucket), for
water meters the water costs from the profitability report; gas has
no cost model yet (`null`). `expectedSettlementEur = paid − actual`,
positive = refund expected. The calendar year is an approximation of the
utility's billing year; the current year is marked as `partial`.

---

## 7. Frontend (Vue 3 + PrimeVue)

New views under `frontend/src/views/meters/`, navigation gated on
`module.meters`:

| View | Permission | Content |
|---|---|---|
| `MetersView.vue` | `meters.view` | Tile/list overview: name, type icon, location, last reading + date, absolute reading, anomaly badge; quick action "Ablesen" (read). Sorted by type (order of `METER_TYPE_LABELS`), then name (`frontend/src/utils/meterSort.ts`) |
| `MeterReportsView.vue` | `meters.view` | All analyses: trend tiles, energy report, profitability, comparison calculations, system condition, season profile, weather-adjusted heating, advance payments — plus the dialog "Tarife & Annahmen" |
| `MeterDetailView.vue` | `meters.view` | Master data, device history (table as in the issue example), readings list, consumption chart with previous-year comparison, linked payments |
| `MeterQuickEntryView.vue` | `meters.read_entry` | Quick reading form with one shared date for all configured meters and OCR camera per meter row |
| `MeterQuickEntryConfigView.vue` | `meters.read_entry` | Personal configuration page for meter selection/order (`meter_quick_entry_items`), reachable via the gear icon in the quick entry |
| `MeterReadingEntryView.vue` (or dialog) | `meters.read_entry` | Value + date/time (default now), photo button → OCR suggestion with confidence, confirm/correct |
| `MetersAdminView.vue` | `meters.manage` | Meter CRUD, replace device (wizard: old final reading → new start value), API key management |
| `MeterAnomaliesView.vue` | `meters.view` (set status: `meters.read_entry`) | Anomalies inbox (§5.3), badge in the module menu |
| `MeterDegreeDaysHelpView.vue` | `meters.view` | Online help on degree days and weather adjustment (§5.2.6), linked from the heating report (pattern: `finance/BankcontactsHelpView.vue`) |

**Meters and analyses are two pages.** The meters page (`/zaehler`)
manages master data and readings — list, create/edit, history
import; the analysis page (`/zaehler/auswertungen`) carries every report.
Both on one page meant: first scrolling past seven panels to get to the
meter list. The tariffs and assumptions sit with the analyses,
because they only take effect there — every price change reloads the cost reports.
Both pages link to each other in the header row, and the module menu leads to
both.

Design: only semantic PrimeVue CSS variables (CSS style guide),
date handling via `frontend/src/utils/dateFormat.ts`
(`toLocalIsoDate`/`parseLocalDate`). Charts as in the Finance views.
Storybook stories for overview + entry dialog.

---

## 8. Stages

| # | Title | Content | Depends on |
|---|---|---|---|
| 1 | DB + permissions | Migration `0121` + `_journal.json`, schema in `db/schema.ts`, seed permissions, service skeleton `meter/` | — |
| 2 | Meter CRUD + devices | `meter.ts`, replace flow, admin view, tests (monotonicity, device-replacement invariants) | 1 |
| 3 | Manual readings | `readings.ts`, absolute-reading calculation, overview + detail view, entry dialog | 2 |
| 4 | Photo OCR | `receipt-ocr-service` endpoint `/meter-reading`, `readings-ocr.ts`, photo storage, confirmation UI | 3 |
| 5 | API ingestion | `meter_api_keys`, `ingest.ts` (bearer, idempotency, rate limit), key management in admin view | 3 |
| 6 | Reports | Implemented (6a–6e, see `documentation/utility-meters-reports.md`), incl. day/week granularity (#1024), season profile A3 (#1022) and weather adjustment C3 (#1023) | 3 |
| 7 | Anomalies | Implemented: job + `meter_anomalies` (migration 0191), inbox with badge (#1015) | 6 |
| 8 | Finance link | Implemented: endpoints, dialog on the reading, report E3 advance-payment comparison (#1018) | 3 (+ Finance) |

MVP = stages 1–3; each stage is tested individually (`npm run test` before
every push) and can be deployed independently.

---

## 9. Tests (per stage, Vitest)

- **Monotonicity**: retroactive/future readings, edge cases of exactly equal
  value, violation → `invalid_argument`.
- **Device replacement**: absolute reading before/after replacement (issue example 102→734,
  new from 3), only one active device per metering point.
- **Ingest**: valid/invalid/disabled key, duplicate (idempotent),
  monotonicity 422, `last_used_at`.
- **Reports**: bucket formation across device replacement, empty periods,
  filter boundaries; later interpolation and previous-year comparison.
- **Permissions**: visibility owner/group, `meters.manage` required for
  CRUD/keys.
- **OCR**: client mocked (pattern `documents/llm-client.test.ts`),
  confidence passthrough, no auto-save.
- **Anomalies** (`anomalies.service.test.ts`): pure detector (spike,
  drop, seasonal rise is not reported, old intervals only
  baseline, minimum baseline, standstill only for operating hours,
  decreasing reading, too-short intervals); job idempotent, withdraws corrected
  findings, keeps confirmed ones; endpoints visibility + permissions.
- **Finance link** (`reading-transactions.test.ts`): link/list/unlink,
  idempotency, meter visibility, finance ACL incl. `finance.admin`,
  `linkedTransactions` in the readings list, advance-payment report.
- **Reports**: day/week buckets (ISO week, turn of the year, day split,
  previous year), season-profile pivot, weather adjustment in both modes.
- **Degree days** (`degree-days.service.test.ts`): VDI sum and
  heating limit, tolerance of missing days, archive lag, parser, home location
  (grid, validation, permissions), backfill with fake archive (only missing
  months, manual entry stays, one call per year, idempotent,
  incomplete months), outage → `unavailable`.
