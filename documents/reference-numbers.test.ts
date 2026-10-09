import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  extractReferenceNumbers,
  isPlausibleReferenceValue,
  mergeReferenceNumbers,
  normalizeReference,
  parseModelReferenceNumbers,
  parseUserReferenceNumbers,
  referenceNumberContains,
  userEntered,
} from "./reference-numbers";

describe("normalizeReference", () => {
  it("keeps letters and digits only, upper-cased", () => {
    expect(normalizeReference("AB 12.345-6/7")).toBe("AB1234567");
    expect(normalizeReference("ab123456")).toBe("AB123456");
  });
});

describe("isPlausibleReferenceValue", () => {
  it("wants a digit and a sensible length", () => {
    expect(isPlausibleReferenceValue("12345")).toBe(true);
    expect(isPlausibleReferenceValue("A-1")).toBe(false);
    expect(isPlausibleReferenceValue("abcdef")).toBe(false);
    expect(isPlausibleReferenceValue("1".repeat(41))).toBe(false);
  });
});

describe("extractReferenceNumbers", () => {
  it("reads labelled numbers with their kind, in order of appearance", () => {
    const text =
      "Beispiel Versicherung AG\nVersicherungsschein-Nr.: HV 12.345.678-9\n" +
      "Kundennummer 0001234567\nIhr Zeichen: ABC/42\nAktenzeichen 7 K 123/24\n" +
      "Vertragsnummer: 998877";
    const refs = extractReferenceNumbers(text);
    expect(refs.map((r) => [r.kind, r.value, r.normalized])).toEqual([
      ["insurance", "HV 12.345.678-9", "HV123456789"],
      ["customer", "0001234567", "0001234567"],
      ["other", "ABC/42", "ABC42"],
      ["case", "7 K 123/24", "7K12324"],
      ["contract", "998877", "998877"],
    ]);
    expect(refs.every((r) => r.source === "regex")).toBe(true);
  });

  it("does not swallow the following word and ignores unlabelled numbers", () => {
    const refs = extractReferenceNumbers("Kundennr. 4711 bitte bei Zahlungen angeben. Betrag 123,45 EUR");
    expect(refs.map((r) => r.value)).toEqual(["4711"]);
  });

  it("dedupes by normalised value", () => {
    const refs = extractReferenceNumbers("Vertragsnummer 12-34-56\nVertragsnr.: 123456");
    expect(refs).toHaveLength(1);
  });
});

describe("parseModelReferenceNumbers", () => {
  it("accepts objects and bare strings, drops junk and unknown kinds become other", () => {
    const refs = parseModelReferenceNumbers([
      { kind: "insurance", value: "AB 123456" },
      { kind: "weird", value: "XY-9999" },
      "778899",
      { kind: "contract", value: "" },
      42,
      { kind: "contract", value: "ab123456" }, // duplicate of the first, normalised
    ]);
    expect(refs.map((r) => [r.kind, r.value, r.source])).toEqual([
      ["insurance", "AB 123456", "model"],
      ["other", "XY-9999", "model"],
      ["other", "778899", "model"],
    ]);
    expect(parseModelReferenceNumbers("nope")).toEqual([]);
  });
});

describe("mergeReferenceNumbers", () => {
  it("prefers user over regex over model per normalised value", () => {
    const regex = extractReferenceNumbers("Vertragsnummer 123456");
    const model = parseModelReferenceNumbers([
      { kind: "insurance", value: "12 34 56" }, // same number, model says insurance
      { kind: "customer", value: "777" },      // too short, dropped already
      { kind: "customer", value: "7777" },
    ]);
    const user = parseUserReferenceNumbers([{ kind: "case", value: "7777" }]);
    const merged = mergeReferenceNumbers(regex, model, user);
    expect(merged.map((r) => [r.kind, r.value, r.source])).toEqual([
      ["case", "7777", "user"],
      ["contract", "123456", "regex"],
    ]);
    expect(userEntered(merged).map((r) => r.value)).toEqual(["7777"]);
  });
});

describe("referenceNumberContains", () => {
  const USER_ID = 950_101;

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO users (id, email, name, password_hash)
      VALUES (${USER_ID}, ${`u${USER_ID}@refs.test`}, 'Refs Test', 'x')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`DELETE FROM documents WHERE user_id = ${USER_ID}`);
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM documents WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  it("finds the document by normalised number through the jsonb containment", async () => {
    const refs = JSON.stringify(parseUserReferenceNumbers([{ kind: "insurance", value: "AB 123456" }]));
    const inserted = await db.execute<{ id: number }>(sql`
      INSERT INTO documents (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status, reference_numbers)
      VALUES (${USER_ID}, ${"ref-test-" + "0".repeat(56)}, 'r.pdf', 'application/pdf', 1, '/tmp/ref-test.pdf', 'ready', ${refs}::jsonb)
      RETURNING id
    `);
    const id = inserted.rows[0]!.id;
    const hit = await db.execute<{ id: number }>(
      sql`SELECT id FROM documents WHERE user_id = ${USER_ID} AND ${referenceNumberContains(normalizeReference("ab-123456"))}`,
    );
    expect(hit.rows.map((r) => r.id)).toEqual([id]);
    const miss = await db.execute<{ id: number }>(
      sql`SELECT id FROM documents WHERE user_id = ${USER_ID} AND ${referenceNumberContains("AB999999")}`,
    );
    expect(miss.rows).toHaveLength(0);
  });
});
