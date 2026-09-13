/**
 * What a partial edit means (§9.2, §20).
 *
 * The rule is three-state and every screen that saves a subset of the
 * fields depends on it. Getting "omitted" and "cleared" confused is
 * silent: the note is saved, the link is gone, and the loss surfaces
 * weeks later when somebody wants the link.
 */

import { describe, expect, it } from "vitest";
import { APIError } from "encore.dev/api";
import {
  resolveDay,
  resolveDwellMinutes,
  resolveText,
  validateUrl,
} from "./field-edit";

describe("a text field on an edit", () => {
  it("leaves what is there when the field was not sent", () => {
    expect(resolveText(undefined, "Eingang um die Ecke", 100, "note"))
      .toBe("Eingang um die Ecke");
  });

  it("clears it for an explicit null", () => {
    expect(resolveText(null, "Eingang um die Ecke", 100, "note")).toBeNull();
  });

  it("clears it for a field somebody emptied", () => {
    // A cleared text field arrives as "" or as spaces, not as null.
    expect(resolveText("", "etwas", 100, "note")).toBeNull();
    expect(resolveText("   ", "etwas", 100, "note")).toBeNull();
  });

  it("trims what it keeps", () => {
    expect(resolveText("  Tickets vorher  ", null, 100, "note")).toBe("Tickets vorher");
  });

  it("refuses more than the field holds", () => {
    expect(() => resolveText("x".repeat(101), null, 100, "note")).toThrow(APIError);
  });
});

describe("a link", () => {
  it("keeps an http or https address", () => {
    expect(validateUrl("https://beispiel.test/x")).toBe("https://beispiel.test/x");
  });

  it("refuses one the app could not open", () => {
    // A `javascript:` string in a field that renders as a tappable
    // link is not a link.
    expect(() => validateUrl("javascript:alert(1)")).toThrow(APIError);
    expect(() => validateUrl("data:text/html,x")).toThrow(APIError);
    expect(() => validateUrl("nicht mal eine url")).toThrow(APIError);
  });

  it("passes a cleared field through", () => {
    expect(validateUrl(null)).toBeNull();
  });
});

describe("how long you stay", () => {
  it("leaves what is there when it was not sent", () => {
    expect(resolveDwellMinutes(undefined, 90)).toBe(90);
  });

  it("takes a corrected figure", () => {
    expect(resolveDwellMinutes(20, 90)).toBe(20);
  });

  it("refuses what no visit looks like", () => {
    expect(() => resolveDwellMinutes(0, 90)).toThrow(APIError);
    expect(() => resolveDwellMinutes(4, 90)).toThrow(APIError);
    expect(() => resolveDwellMinutes(481, 90)).toThrow(APIError);
    expect(() => resolveDwellMinutes(12.5, 90)).toThrow(APIError);
  });
});

describe("a date on an edit", () => {
  it("leaves, clears and takes, like the rest", () => {
    expect(resolveDay(undefined, "2026-05-01", "validTo")).toBe("2026-05-01");
    expect(resolveDay(null, "2026-05-01", "validTo")).toBeNull();
    expect(resolveDay("", "2026-05-01", "validTo")).toBeNull();
    expect(resolveDay("2026-06-30", null, "validTo")).toBe("2026-06-30");
  });

  it("refuses anything that is not a day", () => {
    expect(() => resolveDay("30.06.2026", null, "validTo")).toThrow(APIError);
    expect(() => resolveDay("2026-6-3", null, "validTo")).toThrow(APIError);
  });
});
