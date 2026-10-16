# Businesses: EÜR, asset register and parcels (Betriebe)

A leased farm (verpachtete Land- und Forstwirtschaft) and a photovoltaic
system are small businesses in the tax sense: each needs an
Einnahmen-Überschuss-Rechnung (EÜR) per year, a register of its fixed
assets with their depreciation (AfA), and — for the farm — the parcels of
land with their leases. The household keeps the bookings, the documents
and the meter readings already; this plan puts the business on top of them
instead of beside them.

## Goal

One place per business that answers, for a tax year: what came in, what
went out, what was written off, what the assets are worth now, which
parcels are leased to whom for how much — and hands the figures to the
tax worksheet (`assistant/tax-worksheet.ts`) and to the forms (Anlage L,
Anlage G, Anlage EÜR, Anlage AV/SZ where the forms ask).

## Decisions

| Question | Decision |
|---|---|
| Where it lives | In the finance service (`finance/businesses.ts`), under Finanzen › Betriebe. A business is a tax entity on top of the household's bookings, not a new module. |
| What a business is | `finance_business`: name, kind (`landwirtschaft`, `photovoltaik`, `gewerbe`, `vermietung`), the Anlage it files under (`anlage-l`, `anlage-g`, `anlage-v`), the owner, notes. Read with `finance.view`, changed with `finance.accounts.manage`. |
| Fixed assets | `finance_business_asset`: name, kind (`gebaeude`, `flaeche`, `maschine`, `pv_anlage`, `sonstiges`), acquisition date and cost, the AfA rate in percent (2 % for a building, 5 % for a PV system over 20 years, 0 for land), an optional AfA start that differs from the acquisition, disposal date and proceeds. The schedule is computed, never stored: linear, pro rata by month in the first and the last year (the month of acquisition counts), down to a residual value of 1 € while the asset is held, the disposal year pro rata up to the month of disposal with the gain or loss against the book value. |
| Parcels | `finance_business_parcel`: Gemarkung, Flur, Flurstück, area in m², use (Acker, Grünland, Wald, Hof, Sonstiges), the lessee, lease period and annual rent, notes; optionally the asset that carries the land's cost. Land is not depreciated; it is tracked so the lease income per parcel and the ground tax can be checked and the sale of a parcel finds its cost. |
| EÜR | Stage 2. The bookings of the year flagged tax-relevant and tagged for the business, mapped to the lines of the Anlage EÜR by a per-business mapping of tags to EÜR lines (Betriebseinnahmen: Pacht, Jagdpacht, Einspeisevergütung …; Betriebsausgaben: Grundsteuer, Versicherung, Instandhaltung, AfA …). AfA comes from the asset register as a non-cash expense. Rendered with the grouped report (`finance/grouped-report.ts`) and its PDF. |
| Photovoltaics | Stage 3. A PV business links the meters of the system; feed-in revenue per year comes from the grid-export meter and the feed-in tariff the meter module keeps (`feed_in`, `pv_capacity_kwp`, `pv_investment_net`). A system of at most 30 kWp (§ 3 Nr. 72 EStG, from 2022) is marked exempt: no EÜR, no Anlage G; the register still keeps the asset. |
| Assistant | Stage 1 already: `list_businesses` and `business_assets(business_id, year)` read the register and the schedule; stage 2 adds `euer_report`, and the tax worksheet lists each business's EÜR under its Anlage. |
| Documents | Stage 4. A lease contract links to its parcel, an invoice to its asset, through `document_links`; the Betrieb page shows them. |

## Stages

**Stage 1 done**: migration 0257, `finance/depreciation.ts`,
`finance/businesses.ts`, pages Finanzen › Betriebe and the business,
assistant tools `list_businesses` and `business_assets`.

1. **Register** (this stage): tables, migration, `finance/depreciation.ts`
   (the schedule as a pure function with tests), CRUD endpoints under
   `/finance/businesses` (`GET /finance/businesses/:id?year=` carries the year's
   depreciation per asset, `GET /finance/business-assets/:id/schedule` the
   whole schedule),
   the pages Finanzen › Betriebe (list) and the business (assets with the
   year's AfA and book values, parcels), the two assistant tools.
2. **EÜR**: tag-to-line mapping per business, the year's EÜR from bookings
   plus AfA, the PDF, the assistant tool, the worksheet integration.
3. **Photovoltaics**: meter link, feed-in revenue from readings, the
   exemption check, the PV asset from the meter's investment figures.
4. **Documents**: links from leases and invoices to parcels and assets.

## Open questions

- The PV system's capacity and commissioning date decide whether it files
  at all (≤ 30 kWp since 2022: exempt). The plan handles both; the business
  carries the flag.
- Whether the farm's parcels are leased as one lease or several; the
  register allows one lessee per parcel and a lease per parcel, which
  covers both.
