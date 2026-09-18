import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintProviderToken, normalisePem, ProviderTokenCache, TOKEN_LIFETIME_MS } from "./apns-jwt";
import { buildApnsMessage, isDeadToken, normaliseDeviceToken, parseEnvironment } from "./apns-payload";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

describe("provider token", () => {
  it("is an ES256 JWT with the key id in the header and team id plus iat in the claims", () => {
    const token = mintProviderToken({ keyId: "ABCDEFGHIJ", teamId: "TEAM123456", privateKey: pem }, 1_700_000_000);
    const [header, claims, signature] = token.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "ES256", kid: "ABCDEFGHIJ" });
    expect(decodeSegment(claims)).toEqual({ iss: "TEAM123456", iat: 1_700_000_000 });
    // JOSE signature: raw r||s, 64 bytes, verifiable with the public key.
    const sig = Buffer.from(signature, "base64url");
    expect(sig).toHaveLength(64);
    const ok = verify("SHA256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig);
    expect(ok).toBe(true);
  });

  it("accepts a PEM whose line breaks arrived as literal backslash-n", () => {
    const flattened = pem.replace(/\n/g, "\\n");
    expect(normalisePem(flattened)).toBe(pem);
    expect(() => mintProviderToken({ keyId: "K", teamId: "T", privateKey: flattened }, 1)).not.toThrow();
  });

  it("re-mints only after the lifetime, and at once after invalidation", () => {
    let now = 1_000_000;
    const cache = new ProviderTokenCache({ keyId: "K", teamId: "T", privateKey: pem }, () => now);
    const first = cache.get();
    now += TOKEN_LIFETIME_MS - 1;
    expect(cache.get()).toBe(first);
    now += 2;
    const second = cache.get();
    expect(second).not.toBe(first);
    cache.invalidate();
    expect(cache.get()).not.toBe(second);
  });
});

describe("apns message", () => {
  it("wraps the push payload in an aps dictionary and keeps the deep link", () => {
    const { body, headers } = buildApnsMessage(
      { title: "Neues Foto", body: "Jemand hat ein Foto hinzugefügt", url: "/app/fotos/alben/12?photoId=34", tag: "photo_added:12:34", data: { kind: "photo_added" } },
      "de.example.photos",
    );
    expect(body).toEqual({
      aps: { alert: { title: "Neues Foto", body: "Jemand hat ein Foto hinzugefügt" }, sound: "default", "thread-id": "photo_added:12:34" },
      url: "/app/fotos/alben/12?photoId=34",
      data: { kind: "photo_added" },
    });
    expect(headers).toEqual({
      "apns-topic": "de.example.photos",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "photo_added:12:34",
    });
  });

  it("omits what the payload does not carry", () => {
    const { body, headers } = buildApnsMessage({ title: "F4mil", body: "x" }, "de.example.photos");
    expect(body).toEqual({ aps: { alert: { title: "F4mil", body: "x" }, sound: "default" } });
    expect(headers["apns-collapse-id"]).toBeUndefined();
  });

  it("caps a long body and a long collapse id", () => {
    const { body, headers } = buildApnsMessage({ title: "t", body: "b".repeat(2000), tag: "t".repeat(100) }, "x");
    const alert = (body.aps as { alert: { body: string } }).alert;
    expect(alert.body.length).toBeLessThanOrEqual(500);
    expect(alert.body.endsWith("…")).toBe(true);
    expect(headers["apns-collapse-id"]).toHaveLength(64);
  });
});

describe("device tokens", () => {
  it("normalises hex tokens and rejects anything else", () => {
    expect(normaliseDeviceToken(" AbCdEf0123456789abcdef0123456789abcdef0123456789abcdef0123456789 ")).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(normaliseDeviceToken("not-a-token")).toBeNull();
    expect(normaliseDeviceToken("abc")).toBeNull();
    expect(normaliseDeviceToken("<abcd 1234>")).toBeNull();
  });

  it("defaults the environment to production", () => {
    expect(parseEnvironment("sandbox")).toBe("sandbox");
    expect(parseEnvironment("production")).toBe("production");
    expect(parseEnvironment(undefined)).toBe("production");
    expect(parseEnvironment("staging")).toBe("production");
  });

  it("knows which refusals mean the token is gone", () => {
    expect(isDeadToken(410, "Unregistered")).toBe(true);
    expect(isDeadToken(400, "BadDeviceToken")).toBe(true);
    expect(isDeadToken(400, "DeviceTokenNotForTopic")).toBe(true);
    expect(isDeadToken(400, "PayloadTooLarge")).toBe(false);
    expect(isDeadToken(403, "ExpiredProviderToken")).toBe(false);
    expect(isDeadToken(429, "TooManyRequests")).toBe(false);
  });
});
