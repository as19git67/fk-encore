/**
 * The provider token APNs wants on every request (#765): a JWT signed
 * ES256 with the .p8 key from the Apple developer account, carrying the
 * Key ID in the header and the Team ID plus an issue time in the claims.
 *
 * Apple accepts a token for up to an hour and rejects one issued more
 * than an hour ago; it also throttles providers that mint a fresh token
 * on every request. So the token is cached and re-minted after fifty
 * minutes. Pure apart from `crypto`, so the shape is testable against a
 * throw-away key.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

export interface ApnsCredentials {
  /** 10-character Key ID of the .p8 key. */
  keyId: string;
  /** 10-character Apple Team ID. */
  teamId: string;
  /** Contents of the .p8 file (PEM). A value with literal `\n` sequences,
   * as an env file tends to store it, is accepted too. */
  privateKey: string;
}

/** Re-mint after this long; Apple's ceiling is 60 minutes. */
export const TOKEN_LIFETIME_MS = 50 * 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** A PEM that arrived through an env file with `\n` written out. */
export function normalisePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/** Mint a provider token, `issuedAt` in epoch seconds. */
export function mintProviderToken(creds: ApnsCredentials, issuedAt: number, key?: KeyObject): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: creds.keyId }));
  const claims = base64url(JSON.stringify({ iss: creds.teamId, iat: issuedAt }));
  const signingInput = `${header}.${claims}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  // APNs wants the raw r||s signature (JOSE), not DER.
  const signature = signer.sign({ key: key ?? createPrivateKey(normalisePem(creds.privateKey)), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

/** Holds one token and re-mints it when it ages out. */
export class ProviderTokenCache {
  private token: string | null = null;
  private mintedAt = 0;
  private key: KeyObject | null = null;

  constructor(private readonly creds: ApnsCredentials, private readonly now: () => number = Date.now) {}

  get(): string {
    const t = this.now();
    if (this.token && t - this.mintedAt < TOKEN_LIFETIME_MS) return this.token;
    if (!this.key) this.key = createPrivateKey(normalisePem(this.creds.privateKey));
    this.token = mintProviderToken(this.creds, Math.floor(t / 1000), this.key);
    this.mintedAt = t;
    return this.token;
  }

  /** Apple answered ExpiredProviderToken: mint a fresh one next time. */
  invalidate(): void {
    this.token = null;
  }
}
