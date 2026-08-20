-- Migration 0147: assign the EV / wallbox roles to already imported meters.
--
-- Migration 0126 allowed 'ev_charger_total' / 'ev_charger_pv' and the energy
-- report reads them, but nothing ever set them: the historical electricity
-- import does not map its wallbox meters to a role. Imported households
-- therefore never saw any wallbox figures in the energy report.

UPDATE meters
SET role = 'ev_charger_total'
WHERE role IS NULL AND type = 'electricity' AND name = 'E-Auto Wallbox';--> statement-breakpoint

UPDATE meters
SET role = 'ev_charger_pv'
WHERE role IS NULL AND type = 'electricity' AND name = 'E-Auto PV-Laden';
