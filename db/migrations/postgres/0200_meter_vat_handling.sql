-- Migration 0200: VAT that never stayed paid.
--
--  * pv_vat_refunded — input VAT the tax office refunded on the PV
--    investment. Under Regelbesteuerung the household got that money back, so
--    the amortization subtracts it: only the net price has to earn itself
--    back. Unit 'eur', one row per investment.
--  * self_consumption_vat_rate — VAT rate owed on self-consumed electricity
--    (unentgeltliche Wertabgabe) while Regelbesteuerung applies. Unit 'ratio',
--    dated: a row of 0 at the switch to Kleinunternehmer ends it without
--    rewriting the years before.

ALTER TABLE meter_electricity_tariffs
  DROP CONSTRAINT IF EXISTS meter_electricity_tariffs_kind_check;--> statement-breakpoint

ALTER TABLE meter_electricity_tariffs
  ADD CONSTRAINT meter_electricity_tariffs_kind_check CHECK (
    kind IN (
      'grid_import',
      'base_price',
      'feed_in',
      'self_consumption_value',
      'pv_investment_net',
      'pv_investment_vat',
      'pv_vat_refunded',
      'self_consumption_vat_rate',
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
      'sewage_price',
      'heating_degree_days',
      'ev_charging_loss'
    )
  );
