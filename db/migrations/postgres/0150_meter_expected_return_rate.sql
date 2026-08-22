-- Migration 0150: expected return rate replaces the pre-computed
-- opportunity-cost and amortization figures.
--
-- 'opportunity_cost_year', 'opportunity_cost_total' and 'amortization_years'
-- were carried over from the source spreadsheet, where they were formula
-- cells: opportunity cost = investment x 5 %, amortization = investment /
-- yearly benefit. They are results, not inputs — keeping them editable meant
-- a stored number could silently contradict the measured benefit it is
-- supposed to be derived from.
--
-- The only genuine assumption behind them is the return the invested money
-- was expected to earn elsewhere. That is kept as 'expected_return_rate'
-- (a ratio, e.g. 0.05 for 5 % a year); everything else is computed in
-- meter/economics.service.ts.

-- Both checks come off first. The kind check rejects 'expected_return_rate'
-- until it is rebuilt, and it cannot be rebuilt while the obsolete rows are
-- still there — so the order is: drop, move the data, add the new ones. The
-- unit check is dropped up front for the same reason, so this migration does
-- not depend on which units the constraint happened to allow before it.
ALTER TABLE meter_electricity_tariffs
  DROP CONSTRAINT IF EXISTS meter_electricity_tariffs_kind_check;--> statement-breakpoint

ALTER TABLE meter_electricity_tariffs
  DROP CONSTRAINT IF EXISTS meter_electricity_tariffs_unit_check;--> statement-breakpoint

-- Derive the rate from what the owner had stored: the yearly opportunity cost
-- divided by the net investment it was calculated from (the spreadsheet's
-- base). Owners without a net investment row keep the spreadsheet's 5 %.
INSERT INTO meter_electricity_tariffs (owner_user_id, kind, valid_from, amount, unit, source)
SELECT
  oc.owner_user_id,
  'expected_return_rate',
  oc.valid_from,
  ROUND(
    COALESCE(
      (SELECT oc.amount / inv.amount
         FROM meter_electricity_tariffs inv
        WHERE inv.owner_user_id = oc.owner_user_id
          AND inv.kind = 'pv_investment_net'
          AND inv.amount > 0
        ORDER BY inv.valid_from
        LIMIT 1),
      0.05
    ),
    6
  ),
  'ratio',
  jsonb_build_object(
    'migration', '0150',
    'note', 'derived from opportunity_cost_year / pv_investment_net'
  )
FROM meter_electricity_tariffs oc
WHERE oc.kind = 'opportunity_cost_year'
ON CONFLICT DO NOTHING;--> statement-breakpoint

DELETE FROM meter_electricity_tariffs
WHERE kind IN ('opportunity_cost_year', 'opportunity_cost_total', 'amortization_years');--> statement-breakpoint

ALTER TABLE meter_electricity_tariffs
  ADD CONSTRAINT meter_electricity_tariffs_kind_check CHECK (
    kind IN (
      'grid_import',
      'base_price',
      'feed_in',
      'self_consumption_value',
      'pv_investment_net',
      'pv_investment_vat',
      'expected_return_rate',
      'gas_price',
      'gas_base_price',
      'boiler_efficiency',
      'heat_pump_scop',
      'ev_consumption',
      'petrol_consumption',
      'petrol_price',
      'grid_co2',
      'gas_co2',
      'petrol_co2',
      'pv_capacity_kwp',
      'water_price',
      'water_base_price',
      'sewage_price'
    )
  );--> statement-breakpoint

-- 'years' was only ever used by 'amortization_years', which is now computed.
ALTER TABLE meter_electricity_tariffs
  ADD CONSTRAINT meter_electricity_tariffs_unit_check CHECK (
    unit IN (
      'eur_per_kwh',
      'eur_per_month',
      'eur',
      'ratio',
      'kwh_per_100km',
      'l_per_100km',
      'eur_per_l',
      'kg_per_kwh',
      'kg_per_l',
      'kw',
      'eur_per_m3'
    )
  );
