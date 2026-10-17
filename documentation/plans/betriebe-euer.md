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
| EÜR | Stage 2. The bookings of the year carrying the business's tag (`booking_tag`; the tax flag is checked and counted, not required), mapped to the lines of the Anlage EÜR by the business's own list of lines (`euer_lines`: name, direction, tags, form line) (Betriebseinnahmen: Pacht, Jagdpacht, Einspeisevergütung …; Betriebsausgaben: Grundsteuer, Versicherung, Instandhaltung, AfA …). AfA comes from the asset register as a non-cash expense. Rendered with the grouped report (`finance/grouped-report.ts`) and its PDF. |
| Photovoltaics | Stage 3. The business carries the system's capacity in kWp (prefilled from the meters' `pv_capacity_kwp` tariff entry when empty), its commissioning date and an optional override of the exemption; the year's feed-in comes from the meters' energy report (`gridExport`, `feedInRevenueEur`). A system of at most 30 kWp (§ 3 Nr. 72 EStG, from 2022) is exempt: its EÜR is for information only, nothing goes into Anlage G; the register still keeps the asset. |
| Assistant | Stage 1 already: `list_businesses` and `business_assets(business_id, year)` read the register and the schedule; stage 2 adds `euer_report`, and the tax worksheet lists each business's EÜR under its Anlage. |
| Documents | Stage 4. A lease contract links to its parcel, an invoice to its asset, a notice to the business, through `finance_business_document` in the finance service (not `document_links`, which joins two documents); the Betrieb page shows them grouped by target and links them from a search over the documents. |

## Stages

**Stage 1 done**: migration 0257, `finance/depreciation.ts`,
`finance/businesses.ts`, pages Finanzen › Betriebe and the business,
assistant tools `list_businesses` and `business_assets`.

**Stage 2 done**: migration 0258 (`booking_tag`, `document_category`,
`euer_lines` on `finance_business`), `finance/euer.ts` (the EÜR as a pure
function: bookings of the year carrying the business's tag sorted into the
lines by their other tags, "Sonstige" by sign for the rest, the register's
AfA as the one non-cash expense, totals and result in cents),
`GET /finance/businesses/:id/euer?year=` and the PDF under `…/euer/pdf`
(`finance/euer-pdf.ts`), the EÜR section with the lines editor on the
business page, assistant tools `euer_report` and `euer_pdf`, and the
businesses' EÜR in the tax worksheet under their Anlage. New businesses
start with lines per kind (`defaultEuerLines`); the user's actual tags
are the household's own — the farm's bookings carry the tag
"Landwirtschaft" and the tax flag, its documents the category
`landwirtschaft`.

**Stage 3 done**: migration 0259 (`pv_capacity_kwp`, `pv_commissioned_on`,
`pv_tax_override` on `finance_business`), `finance/pv.ts` (the § 3 Nr. 72
EStG rule: from 2022, up to 30 kWp exempt; no capacity → status unknown;
the override for cases the simple rule does not cover), the PV card on
the business page with capacity (the business's own, else the meters'
tariff timeline), commissioning, status and reason, and the year's feed-in
from the meters' energy report (`GET /meters/reports/energy`); an exempt
system's EÜR is marked "for information" on the page, in the PDF, in
`euer_report` and in the tax worksheet. The capacity is the user's entry,
never a constant in the code.

**Stage 4 done**: migration 0260 (`finance_business_document`: the link
of a document to the business, one of its assets or one of its parcels,
with a note), endpoints `GET/POST /finance/businesses/:id/documents` and
`DELETE /finance/business-documents/:id` (a link is only made for a
document the caller can read now, checked through `documents.getDocument`;
the list carries each document's meta as the documents module serves it,
or null when it is no longer readable), the Dokumente section on the
business page grouped by target with a search dialog over the documents
(category of the business preselected), and the assistant tool
`business_documents`. The link lives in the finance service; the
documents module is not changed.

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
