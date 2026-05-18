import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeNamePrefix, containerName, volumeName } from "./naming";

const original = process.env.OSM_ADMIN_NAME_PREFIX;
beforeEach(() => {
  delete process.env.OSM_ADMIN_NAME_PREFIX;
});
afterEach(() => {
  if (original === undefined) delete process.env.OSM_ADMIN_NAME_PREFIX;
  else process.env.OSM_ADMIN_NAME_PREFIX = original;
});

describe("naming with default (empty) prefix", () => {
  it("containerName matches the historical scheme so existing deployments keep their containers", () => {
    expect(containerName("nominatim", "europe-germany-bayern")).toBe(
      "nominatim-europe-germany-bayern",
    );
    expect(containerName("overpass", "europe-germany-bayern")).toBe(
      "overpass-europe-germany-bayern",
    );
  });

  it("volumeName matches the historical scheme too", () => {
    expect(volumeName("nominatim", "europe-germany-bayern")).toBe(
      "fk-encore-osm-nominatim-europe-germany-bayern",
    );
    expect(volumeName("overpass", "europe-germany-bayern")).toBe(
      "fk-encore-osm-overpass-europe-germany-bayern",
    );
  });

  it("activeNamePrefix reports empty", () => {
    expect(activeNamePrefix()).toBe("");
  });
});

describe("naming with OSM_ADMIN_NAME_PREFIX set", () => {
  it("scopes both container and volume names", () => {
    process.env.OSM_ADMIN_NAME_PREFIX = "test-";
    expect(containerName("nominatim", "bayern")).toBe("test-nominatim-bayern");
    expect(containerName("overpass", "bayern")).toBe("test-overpass-bayern");
    expect(volumeName("nominatim", "bayern")).toBe("test-fk-encore-osm-nominatim-bayern");
    expect(volumeName("overpass", "bayern")).toBe("test-fk-encore-osm-overpass-bayern");
    expect(activeNamePrefix()).toBe("test-");
  });

  it("re-reads the env on every call (no module-load capture)", () => {
    expect(containerName("nominatim", "x")).toBe("nominatim-x");
    process.env.OSM_ADMIN_NAME_PREFIX = "prod-";
    expect(containerName("nominatim", "x")).toBe("prod-nominatim-x");
    delete process.env.OSM_ADMIN_NAME_PREFIX;
    expect(containerName("nominatim", "x")).toBe("nominatim-x");
  });

  it("respects an explicit prefixOverride argument over the env", () => {
    process.env.OSM_ADMIN_NAME_PREFIX = "should-be-ignored-";
    expect(containerName("nominatim", "x", "explicit-")).toBe("explicit-nominatim-x");
    expect(volumeName("nominatim", "x", "")).toBe("fk-encore-osm-nominatim-x");
  });
});
