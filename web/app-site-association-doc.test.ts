import { describe, expect, it } from "vitest";
import { buildAppSiteAssociation, CLAIMED_COMPONENTS, parseAppIds } from "./app-site-association-doc";

describe("parseAppIds", () => {
  it("is empty when unset", () => {
    expect(parseAppIds(undefined)).toEqual([]);
    expect(parseAppIds("")).toEqual([]);
  });

  it("accepts TEAMID.bundle.id entries, trimmed, in a comma-separated list", () => {
    expect(parseAppIds(" ABCDE12345.de.example.photos , ABCDE12345.de.example.photos.share "))
      .toEqual(["ABCDE12345.de.example.photos", "ABCDE12345.de.example.photos.share"]);
  });

  it("drops entries that are not app identifiers", () => {
    expect(parseAppIds("de.example.photos,ABCDE12345.de.example.photos,abc")).toEqual([
      "ABCDE12345.de.example.photos",
    ]);
  });
});

describe("buildAppSiteAssociation", () => {
  const doc = buildAppSiteAssociation(["ABCDE12345.de.example.photos"]);
  const details = (doc.applinks as { details: Array<Record<string, unknown>> }).details;

  it("names the app under applinks.details[0].appIDs", () => {
    expect(details).toHaveLength(1);
    expect(details[0].appIDs).toEqual(["ABCDE12345.de.example.photos"]);
  });

  it("claims only the photo routes the app can open", () => {
    const paths = (details[0].components as Array<Record<string, unknown>>).map((c) => c["/"]);
    expect(paths).toEqual(CLAIMED_COMPONENTS.map((c) => c["/"]));
    expect(paths.every((p) => typeof p === "string" && p.startsWith("/app/"))).toBe(true);
    for (const p of paths as string[]) {
      expect(p).not.toMatch(/dokumente|finanzen|admin/);
    }
  });

  it("claims a bare gallery link only together with a photoId", () => {
    const gallery = CLAIMED_COMPONENTS.find((c) => c["/"] === "/app/fotos/galerie");
    expect(gallery?.["?"]).toEqual({ photoId: "*" });
  });

  it("serialises to a small JSON document", () => {
    const json = JSON.stringify(doc);
    expect(JSON.parse(json)).toEqual(doc);
    expect(json.length).toBeLessThan(128 * 1024);
  });
});
