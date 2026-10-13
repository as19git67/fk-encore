# Forecast (Finance › Prognose): audit of the calculations

As of 2026-09-28. Audited were the simulation (`finance/forecast-engine.ts`),
the what-if calculations (`finance/forecast-analysis.ts`), the mapping
of the stored data onto the engine (`finance/forecast.ts`), the
spreadsheet import (`finance/forecast-import.ts`), the reading of pension statements
and transactions (`finance/forecast-statements-extract.ts`,
`finance/forecast-bookings-extract.ts`) and the display in the frontend
(purchasing-power conversion, percentage fields, charts, dialogs).

All examples here are invented.

Addendum: The one-off spreadsheet import no longer exists (removed because
it is never needed again). The points on the import below describe what
applied during the audit; items that were already imported still carry the origin
„Excel-Import“ (Excel import).

## Fixed (commit „Forecast: corrections from the calculation audit“)

### Engine

1. **Savings accounts compounded at the scenario interest rate, tax-free.** An
   asset item in the „Tagesgeld / Konto“ (savings / account) pot without its own return got
   the default interest rate (4 %), and interest on cash was not taxed.
   Over 30 years this triples the cash pot. Now: empty = 0 % for
   cash, default interest rate only for securities account/other/real estate; interest on
   cash is taxed at a flat rate like other capital gains. Real estate
   stays untaxed (appreciation is not realized).
2. **Statutory pension: pension adjustment only from the pension start.** The
   pension information states the pension in today's values (current
   pension value, without future adjustments). The engine left the amount unchanged
   until the start and only revalued it afterwards; at 2 % and 10 years
   until the start, 22 % of the nominal pension was missing. Now a
   statutory pension is carried forward from today; occupational and private pensions
   stay nominal at the start (this is how the pension statement projects them).
3. **Statutory pension: leaving earlier did not lower the pension.** The
   projected pension assumes contributions until the standard retirement age.
   Someone who stops at 61 instead of 67 does not earn the remaining earnings points.
   New field „Bisher erreichte Anwartschaft“ (entitlement reached so far; it appears in every
   pension information): the pension then lies between entitlement and
   projection in proportion to the months worked; the deduction for
   the earlier start is applied on top. Without the field the projection still applies.
   The statement reader now knows the value („bisher erreichte
   Rentenanwartschaft“) and suggests it.
4. **Pension start in the birth month.** A statutory pension starts with the
   month after the birth month (§ 99 SGB VI); for someone born on the 1st, in the
   birth month. Applies to the point in time „Gesetzliche Rente“ (statutory pension) and to the
   deduction calculation (months before the standard retirement age).
5. **Standard retirement age flat 67.** New persons now get it by
   birth year (65 up to 1946, rising, 67 from 1964; intermediate months
   rounded to whole years).
6. **Lump-sum option with €0 paid nothing.** If „Einmalzahlung statt Rente“ (lump sum instead of pension)
   was selected and the amount was then deleted, the engine paid €0 once
   and no pension. Now: lump sum only for amount > 0; the dialog
   resets to pension when the amount is deleted.
7. **Sensitivity/levers did not apply to assets with their own return.** The
   return steps only shifted the default interest rate; a securities account with its own
   5 % stayed untouched. Now every asset except cash is shifted by the same
   step.
8. Dead variable `toPots` removed (no double counting, it was unused).

### Mapping / import / pension statements

9. **One-off amounts in the current year silently dropped out** (start „1. Januar“
   (1 January) lay before the simulation start). Now: current month.
10. **An expired life insurance was paid out again at the start.** An expiry year
    in the past is no longer imported; expiry in the current year is marked
    „bitte prüfen“ (please check).
11. **Imported statutory pensions were tied to fixed dates** and
    did not react to the „Gesetzliche Rente“ slider, with no deduction for an
    earlier start. On import they are now bound to the person's
    point in time, standard age = payout year − birth year, deduction
    0.3 %/month. **Pensions that were already imported are not affected**:
    there, set „Beginn“ (start) in the dialog to the point in time „Gesetzliche Rente“
    and enter standard retirement age/deduction.
12. Import: a cell „1“ for interest rates means 1 %, not 100 %.
13. Health insurance got no correction suggestion from contribution
    invoices (transactions did). Now: „Beitrag pro Monat“ (contribution per month) →
    contribution during working life.
14. A contribution-free insurance contract („Beitrag 0,00 €“) was discarded;
    0 is now permitted for contributions. Expenses without a rhythm count as
    monthly (as in the engine). „neuer Beitrag … jährlich“ (new contribution … annually) no longer ends up
    as a monthly contribution.
15. Current accounts and cash are suggested as asset items (that is where
    the monthly surplus lands); a negative account balance is not
    an asset and is read as 0.

### Frontend

16. **The health-insurance line in the cash-flow chart sat on top of the total expenses**
    (stacked axis without its own stack). Now a separate stack.
17. **Exit age from a date** was one too high when the birthday falls later in the year
    (year difference instead of age). Now taken from the result of the
    engine. „Aktuelles Alter“ (current age; household, slider minimum, target age) from the
    full date of birth.
18. Buffer line („Sicherheitspuffer“, safety buffer) in the wealth chart is now deflated at
    „heutige Kaufkraft“ (today's purchasing power); pots stacked so that the boundary
    above „Sonstiges“ (other) equals the available wealth.
19. Bridging: deflation never with a year before the start. Percentage fields
    show 26.375 % instead of 26.38 %. Text „mit keinem Alter bis 75“ (with no age up to 75) instead of up to
    final age. Matrix tooltip „Geld geht {Jahr} aus“ (money runs out in {year}). First year in the chart
    marked as a partial year („2026 (ab Sep.)“, from Sep.). Label stating from when
    increase/adjustment applies.

## Addendum: health insurance after working life

Note from use: the salary is net, the employee share is already included;
health insurance only becomes interesting after exit, and there it depends
on whether the prior insurance period for the KVdR (health insurance for pensioners) is reached.

20. **Working life**: „Beitrag bis zum Ausstieg“ (contribution until exit) now defaults to 0
    and is described as a supplementary contribution; a „Krankenversicherung“ (health insurance) item
    costs nothing during working life as long as nothing is entered.
21. **Voluntary statutory** (without KVdR): assessment from all income of the
    person — salary, pensions of every kind, rents, annuities — plus the
    same share of income without a person (household) plus the
    capital gains of the previous month (interest, dividends, price gains of the
    cash/securities account/other pots; own assets in full, household assets in
    equal parts; real estate appreciation not). Capped at the
    contribution assessment ceiling (scenario, grows with inflation), at least
    the minimum contribution. Before: only own income, no capital gains,
    no cap.
22. **KVdR**: statutory pension with half the health-insurance rate plus the full long-term-care rate
    (new scenario field „davon Pflegeversicherung“, of which long-term care insurance), occupational pension at the full
    rate, private pensions and capital gains contribution-free, cap at the
    ceiling. Before: full rate on all pensions.
23. Lump-sum payments (lump-sum option, maturity benefit) do not count toward the assessment
    in any variant; in reality a direct insurance would be spread over
    120 months as a pension benefit — not modeled.
24. The document reader now only suggests amounts for health insurance that are actually
    paid as a premium (supplementary contribution, private tariffs); the
    statutory modes are calculated.

Simplifications: assessment monthly instead of by the previous year's
income tax assessment; no saver's allowance; for the KVdR it is not checked whether the
9/10 rule is met — that is decided by the choice of mode per person.

## Addendum: survivor scenario (#1341)

Death as a scenario setting (person, age), not as a stored
point in time. From the birth month of the chosen age: salary, income,
expenses, health insurance, care costs and the person's own pensions
end; running contributions into pensions and life insurances of the person
end. The other person receives the survivor share of the pensions
(field on the pension item; default 55 % statutory, 60 % occupational pension, 0 %
private); for the statutory pension, own income of the previous month
above the allowance is deducted at the offset rate (default 40 %,
€1,038). Life insurances on the life of the person pay out
the death benefit (field; empty = guaranteed maturity benefit) tax-free and
end; a running annuity ends. Cost of living × factor (default
70 %); the expense curve follows the surviving person when the
reference person dies. Result: verdict and curves as usual, plus the
comparison „Ohne Todesfall“ (without death) and the quick check across every age of death.

Simplifications: no pension deductions on the widow's pension for death before 65,
no death quarter (Sterbevierteljahr), no spreading of a direct insurance; the
allowance applies flat (no child supplements); inheritance tax not
modeled; the health-insurance classification of the surviving person stays as chosen on the item
(family insurance via the deceased person would have to be
changed by hand).

## Addendum: plan versus reality (#1342)

A snapshot (`finance_forecast_snapshot`) records the annual series of a
scenario (wealth and available wealth at each year end) and the
available wealth on the day of capture — by hand or once a
month via cron per scenario. „Erwartet für heute“ (expected for today) is interpolated linearly between the
starting value and the year ends; what is compared is the
**available** wealth (cash, securities account, other: linked accounts with
current balance, otherwise the entered value), because the forecast's verdict
rests on it.

Actual values from the transactions of the last twelve full months across all
accounts of the household: income, expenses and savings rate per month, excluding
transfers between own accounts (counter IBAN belongs to the household or
mirror transaction of the same amount on another account within three
days). Planned expenses = cost of living plus running expenses of the items,
planned savings rate = income minus expenses of the first full simulation year.
„Lebenshaltung übernehmen“ (adopt cost of living) writes the actual expenses into the one
cost-of-living item.

Simplifications: expenses contain everything that flows out (also insurance
contributions and savings plans to third-party securities accounts without a mirror transaction); cash
withdrawals count as expenses; no notification on deviation.

## Checked and fine

- Purchasing power: all series and detail values are deflated with their year and the same
  start year; final wealth with the final year; matrix likewise.
- No double counting: contributions/premiums appear once in the expenses;
  savings plans are transfers cash → pot and not an expense.
- Percent ↔ fraction in all fields; deduction 0.3 % per month × months;
  monthly compounding `(1+r)^(1/12)`; securities account sale gross with tax on
  the gain portion; withdrawal order; life insurance linear from the
  surrender value to the maturity benefit, payout/pension/cancellation; health-insurance modes;
  expense curve and care; horizon and year-end closing.
- Import: annual values → month, ends exclusive, signs, pots;
  pension-statement suggestions in the unit of the item; transaction rhythm.

## Known simplifications (deliberate, documented)

- Taxes flat: capital gains are taxed when they arise
  (conservative; no allowance, no advance lump sum); pensions and
  payouts at a fixed rate per item; no income tax.
- Health insurance (details in the addendum above, points 21–23): assessment
  monthly instead of by the previous year's tax assessment; capital gains of
  voluntarily insured persons from the previous month, without saver's allowance;
  lump sums do not count (the 120-month spreading of
  pension benefits is missing); whether the 9/10 rule is met for the KVdR is
  decided by the choice of mode per person.
- No surcharge for a later pension start (0.5 %/month).
- The row „Überbrückung gedeckt / nicht gedeckt“ (bridging covered / not covered) compares need and
  available wealth at the start without returns during the phase; the verdict
  „Geld reicht“ (money suffices) comes from the full simulation.
- Safety buffer is nominal and does not grow with inflation.
- Account balance of a securities account: balance row before position total; whether the FinTS balance
  of a securities account is the settlement account would have to be checked.
- Timeline: dragging a date point calculates in calendar years.
