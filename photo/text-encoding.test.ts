import { describe, it, expect } from "vitest";
import { repairMojibake } from "./text-encoding";

describe("repairMojibake", () => {
  it("repairs classic UTF-8-as-Latin-1 mojibake", () => {
    // "Brüssel" where the UTF-8 bytes for ü (C3 BC) were read as two
    // Latin-1 characters Ã¼.
    expect(repairMojibake("BrÃ¼ssel")).toBe("Brüssel");
    expect(repairMojibake("Garching bei MÃ¼nchen")).toBe(
      "Garching bei München",
    );
    expect(repairMojibake("KÃ¶ln")).toBe("Köln");
    expect(repairMojibake("ZÃ¼rich")).toBe("Zürich");
  });

  it("leaves already-clean UTF-8 strings unchanged", () => {
    expect(repairMojibake("Brüssel")).toBe("Brüssel");
    expect(repairMojibake("Köln")).toBe("Köln");
    expect(repairMojibake("München")).toBe("München");
    expect(repairMojibake("")).toBe("");
  });

  it("leaves plain ASCII strings unchanged", () => {
    expect(repairMojibake("Berlin")).toBe("Berlin");
    expect(repairMojibake("New York")).toBe("New York");
  });

  it("passes null and undefined through", () => {
    expect(repairMojibake(null)).toBeNull();
    expect(repairMojibake(undefined)).toBeUndefined();
  });

  it("does not touch Latin-1-only strings that are not mojibake", () => {
    // A single high-bit char without a "Ã" prefix is genuine Latin-1 text,
    // not UTF-8-as-Latin-1 — leave it alone.
    expect(repairMojibake("café")).toBe("café");
  });
});
