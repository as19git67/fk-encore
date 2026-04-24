/**
 * AES-256-GCM credential crypto for finance_bankcontact.
 *
 * Plaintext credentials (bank PIN / password) NEVER touch the database
 * or the logs. They pass through encryptCredentials on the way in and
 * decryptCredentials on the way out.
 *
 * Key source: Encore secret `FinanceCredentialsKey`, expected to be a
 * base64-encoded 32-byte random key. Generate for local dev via:
 *
 *   node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
 *
 * Blob layout (base64 of the concatenation):
 *   iv (12 bytes) | ciphertext (var) | authTag (16 bytes)
 *
 * Rotation: set a fresh secret, run a re-encrypt script that uses
 * `encryptWithKey` / `decryptWithKey` against the old + new key, deploy.
 *
 * Architecture: docs/finance-fints-integration.md §3.
 */

import { secret } from "encore.dev/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

console.log("[boot] finance/encryption.ts: all imports resolved");

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const financeCredentialsKey = secret("FinanceCredentialsKey");

/**
 * Decodes the Encore secret into the active encryption key. Throws if
 * the secret is missing, not base64, or the wrong length — all three
 * are configuration errors the operator needs to notice immediately.
 */
function getActiveKey(): Buffer {
  let b64: string;
  try {
    b64 = financeCredentialsKey();
  } catch (err) {
    throw new Error(
      "FinanceCredentialsKey secret is not set. Run " +
        "`encore secret set --type local FinanceCredentialsKey <base64>` " +
        "with a 32-byte base64 key."
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `FinanceCredentialsKey must decode to ${KEY_BYTES} bytes, got ${key.length}`
    );
  }
  return key;
}

/** Encrypts `plain` with an explicit key — used by rotation scripts and tests. */
export function encryptWithKey(key: Buffer, plain: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be exactly ${KEY_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Decrypts `blob` with an explicit key — used by rotation scripts and tests. */
export function decryptWithKey(key: Buffer, blob: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be exactly ${KEY_BYTES} bytes`);
  }
  const raw = Buffer.from(blob, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("ciphertext blob is too short");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Production entry point — encrypts with the currently active secret key. */
export function encryptCredentials(plain: string): string {
  return encryptWithKey(getActiveKey(), plain);
}

/** Production entry point — decrypts with the currently active secret key. */
export function decryptCredentials(blob: string): string {
  return decryptWithKey(getActiveKey(), blob);
}
