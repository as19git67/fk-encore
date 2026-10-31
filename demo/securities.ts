/**
 * The securities of the demo depot (documentation/plans/demodaten.md,
 * stage 3): real, widely held broad index funds, so the depot gets real
 * quotes from the configured provider like any depot. Only broad index
 * funds, never single stocks: the list says nothing about anyone's
 * holdings. Identified by ISIN only — the provider resolves the rest.
 */

export interface DemoSecurity {
  isin: string;
  name: string;
  /** How the fund pays out: `null` keeps its income (accumulating). */
  payout: { perYear: 2 | 4; months: number[]; yieldPct: number } | null;
}

export const DEMO_SECURITIES: readonly DemoSecurity[] = [
  { isin: "IE00B4L5Y983", name: "iShares Core MSCI World UCITS ETF USD (Acc)", payout: null },
  { isin: "IE00BKM4GZ66", name: "iShares Core MSCI EM IMI UCITS ETF USD (Acc)", payout: null },
  { isin: "IE00BKX55T58", name: "Vanguard FTSE Developed Europe UCITS ETF EUR (Dist)", payout: { perYear: 4, months: [2, 5, 8, 11], yieldPct: 2.8 } },
  { isin: "IE00B4WXJJ64", name: "iShares Core Euro Government Bond UCITS ETF EUR (Dist)", payout: { perYear: 2, months: [0, 6], yieldPct: 2.2 } },
];

/** The depot's number at the demo bank: printed on every paper, so the pipeline finds the depot by it. */
export const DEMO_DEPOT_NUMBER = "0000200001";
