/**
 * The EODHD provider from the deployment's configuration: the secret
 * `EodhdApiToken`, and `FINANCE_EODHD_DAILY_CALLS` for a plan with more
 * than the free 20 calls a day. Without the token there is no EODHD.
 */

import { secret } from "encore.dev/config";

import { createEodhdProvider, type EodhdProvider } from "./quote-provider-eodhd";

const eodhdApiToken = secret("EodhdApiToken");

export function eodhdFromEnvironment(): EodhdProvider | null {
  let token: string;
  try {
    token = eodhdApiToken().trim();
  } catch {
    return null;
  }
  if (!token) return null;
  const raw = Number(process.env.FINANCE_EODHD_DAILY_CALLS);
  return createEodhdProvider(token, Number.isInteger(raw) && raw > 0 ? raw : undefined);
}
