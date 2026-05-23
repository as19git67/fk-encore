import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

import {
  decryptCredentialBundle,
  encryptCredentialBundle,
  encryptCredentials,
  encryptWithKey,
  decryptWithKey,
} from "./encryption";

const KEY = () => randomBytes(32);

describe("finance/encryption — roundtrip", () => {
  it("round-trips ASCII", () => {
    const k = KEY();
    const plain = "hunter2";
    expect(decryptWithKey(k, encryptWithKey(k, plain))).toBe(plain);
  });

  it("round-trips UTF-8 with Umlauts", () => {
    const k = KEY();
    const plain = "Straße & Grüße";
    expect(decryptWithKey(k, encryptWithKey(k, plain))).toBe(plain);
  });

  it("round-trips emoji", () => {
    const k = KEY();
    const plain = "💶 1.234,56 €";
    expect(decryptWithKey(k, encryptWithKey(k, plain))).toBe(plain);
  });

  it("round-trips the empty string", () => {
    const k = KEY();
    expect(decryptWithKey(k, encryptWithKey(k, ""))).toBe("");
  });

  it("produces a different blob each call (IV randomness)", () => {
    const k = KEY();
    const plain = "identical input";
    const blobs = new Set<string>();
    for (let i = 0; i < 8; i++) {
      blobs.add(encryptWithKey(k, plain));
    }
    expect(blobs.size).toBe(8);
  });
});

describe("finance/encryption — tampering", () => {
  it("rejects a blob whose auth tag has been flipped", () => {
    const k = KEY();
    const blob = encryptWithKey(k, "super-secret");
    const raw = Buffer.from(blob, "base64");
    // flip the last byte of the auth tag
    raw[raw.length - 1] ^= 0x01;
    const tampered = raw.toString("base64");
    expect(() => decryptWithKey(k, tampered)).toThrow();
  });

  it("rejects a blob whose ciphertext has been flipped", () => {
    const k = KEY();
    const blob = encryptWithKey(k, "super-secret");
    const raw = Buffer.from(blob, "base64");
    // flip one byte in the middle (inside the ciphertext region)
    raw[14] ^= 0x01;
    const tampered = raw.toString("base64");
    expect(() => decryptWithKey(k, tampered)).toThrow();
  });

  it("rejects a blob encrypted under a different key", () => {
    const blob = encryptWithKey(KEY(), "super-secret");
    expect(() => decryptWithKey(KEY(), blob)).toThrow();
  });

  it("rejects a blob that is too short to hold iv + tag", () => {
    const k = KEY();
    const tooShort = Buffer.alloc(20).toString("base64");
    expect(() => decryptWithKey(k, tooShort)).toThrow();
  });
});

describe("finance/encryption — key validation", () => {
  it("rejects a non-32-byte key on encrypt", () => {
    expect(() => encryptWithKey(Buffer.alloc(16), "x")).toThrow();
    expect(() => encryptWithKey(Buffer.alloc(64), "x")).toThrow();
  });

  it("rejects a non-32-byte key on decrypt", () => {
    expect(() => decryptWithKey(Buffer.alloc(16), "AAAA")).toThrow();
  });
});

describe("finance/encryption — credential bundle (Issue #427)", () => {
  it("round-trips a FinTS bundle", () => {
    const blob = encryptCredentialBundle({ kind: "fints", pin: "hunter2" });
    expect(decryptCredentialBundle(blob)).toEqual({
      kind: "fints",
      pin: "hunter2",
    });
  });

  it("round-trips a PayPal bundle with all optional fields", () => {
    const bundle = {
      kind: "paypal" as const,
      refreshToken: "rt-abc",
      accessToken: "at-xyz",
      accessTokenExpiresAt: "2026-06-01T12:00:00.000Z",
    };
    const blob = encryptCredentialBundle(bundle);
    expect(decryptCredentialBundle(blob)).toEqual(bundle);
  });

  it("round-trips a PayPal bundle with only the refresh token", () => {
    const blob = encryptCredentialBundle({
      kind: "paypal",
      refreshToken: "rt-only",
    });
    expect(decryptCredentialBundle(blob)).toEqual({
      kind: "paypal",
      refreshToken: "rt-only",
      accessToken: undefined,
      accessTokenExpiresAt: undefined,
    });
  });

  it("decrypts legacy plain-PIN blobs as a FinTS bundle", () => {
    // Old rows stored the raw PIN. New decode path must keep working
    // without touching the data.
    const legacy = encryptCredentials("legacy-pin-1234");
    expect(decryptCredentialBundle(legacy)).toEqual({
      kind: "fints",
      pin: "legacy-pin-1234",
    });
  });

  it("rejects a bundle with an unknown kind", () => {
    const blob = encryptCredentials(JSON.stringify({ kind: "klarna" }));
    expect(() => decryptCredentialBundle(blob)).toThrow(/unknown credential bundle/i);
  });

  it("rejects a FinTS bundle without a pin", () => {
    const blob = encryptCredentials(JSON.stringify({ kind: "fints" }));
    expect(() => decryptCredentialBundle(blob)).toThrow(/missing string `pin`/i);
  });

  it("rejects a JSON object without a kind discriminator", () => {
    const blob = encryptCredentials(JSON.stringify({ pin: "no-kind" }));
    expect(() => decryptCredentialBundle(blob)).toThrow();
  });
});
