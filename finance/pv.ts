/**
 * The income-tax status of a photovoltaic system (documentation/plans/
 * betriebe-euer.md, stage 3). Since the tax year 2022, § 3 Nr. 72 EStG
 * exempts the income of a system of at most 30 kWp (per single-family
 * house or commercial unit; 15 kWp per unit in a multi-unit building,
 * 100 kWp per taxpayer in all). An exempt system files no EÜR and no
 * Anlage G; the register still keeps the asset. The rule is applied from
 * the capacity the user entered; a case the simple rule does not cover
 * (several systems, a multi-unit building) takes the override.
 */

import type { PvTaxOverride } from "../db/schema";

/** The first tax year § 3 Nr. 72 EStG applies to. */
export const PV_EXEMPTION_FROM_YEAR = 2022;
/** Capacity up to which a system on a single-family house is exempt. */
export const PV_EXEMPTION_MAX_KWP = 30;

export interface PvTaxStatus {
  /** null: cannot be derived (no capacity entered) and no override set. */
  exempt: boolean | null;
  /** Why, in the user's language, as the page and the tools print it. */
  reason: string;
  source: "override" | "rule" | "unknown";
}

export function pvTaxStatus(input: { capacityKwp: number | null; year: number; override: PvTaxOverride | null }): PvTaxStatus {
  if (input.override === "exempt") {
    return { exempt: true, reason: "Als steuerfrei eingetragen (§ 3 Nr. 72 EStG).", source: "override" };
  }
  if (input.override === "taxable") {
    return { exempt: false, reason: "Als steuerpflichtig eingetragen.", source: "override" };
  }
  if (input.year < PV_EXEMPTION_FROM_YEAR) {
    return { exempt: false, reason: `Vor ${PV_EXEMPTION_FROM_YEAR} gilt § 3 Nr. 72 EStG nicht: Einnahmen sind steuerpflichtig (Anlage G, EÜR).`, source: "rule" };
  }
  if (input.capacityKwp === null) {
    return { exempt: null, reason: "Leistung in kWp fehlt; ob § 3 Nr. 72 EStG greift, lässt sich nicht sagen.", source: "unknown" };
  }
  if (input.capacityKwp <= PV_EXEMPTION_MAX_KWP) {
    return {
      exempt: true,
      reason: `${formatKwp(input.capacityKwp)} kWp, höchstens ${PV_EXEMPTION_MAX_KWP} kWp: Einnahmen und Entnahmen sind ab ${PV_EXEMPTION_FROM_YEAR} steuerfrei (§ 3 Nr. 72 EStG), keine EÜR und keine Anlage G.`,
      source: "rule",
    };
  }
  return {
    exempt: false,
    reason: `${formatKwp(input.capacityKwp)} kWp, über ${PV_EXEMPTION_MAX_KWP} kWp: § 3 Nr. 72 EStG greift nicht, Einnahmen sind steuerpflichtig (Anlage G, EÜR).`,
    source: "rule",
  };
}

function formatKwp(n: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(n);
}
