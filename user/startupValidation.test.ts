import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateAuthEnvironment } from "./startupValidation";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env.RP_ORIGIN = originalEnv.RP_ORIGIN;
  process.env.RP_NAME = originalEnv.RP_NAME;
  process.env.NODE_ENV = originalEnv.NODE_ENV;
});

describe("validateAuthEnvironment", () => {
  it("passes with both RP_ORIGIN and RP_NAME set", () => {
    process.env.RP_ORIGIN = "http://localhost:5173";
    process.env.RP_NAME = "Test App";
    process.env.NODE_ENV = "test";

    expect(() => validateAuthEnvironment()).not.toThrow();
  });

  it("throws when RP_ORIGIN is missing", () => {
    process.env.RP_ORIGIN = "";
    process.env.RP_NAME = "Test App";

    expect(() => validateAuthEnvironment()).toThrow("RP_ORIGIN");
  });

  it("throws when RP_NAME is missing", () => {
    process.env.RP_ORIGIN = "http://localhost:5173";
    process.env.RP_NAME = "";

    expect(() => validateAuthEnvironment()).toThrow("RP_NAME");
  });

  it("throws in production when RP_ORIGIN uses HTTP", () => {
    process.env.RP_ORIGIN = "http://example.com";
    process.env.RP_NAME = "Prod App";
    process.env.NODE_ENV = "production";

    expect(() => validateAuthEnvironment()).toThrow("HTTPS");
  });

  it("does not throw in production when RP_ORIGIN uses HTTPS", () => {
    process.env.RP_ORIGIN = "https://example.com";
    process.env.RP_NAME = "Prod App";
    process.env.NODE_ENV = "production";

    expect(() => validateAuthEnvironment()).not.toThrow();
  });

  it("does not throw in development with HTTP origin", () => {
    process.env.RP_ORIGIN = "http://localhost:5173";
    process.env.RP_NAME = "Dev App";
    process.env.NODE_ENV = "development";

    expect(() => validateAuthEnvironment()).not.toThrow();
  });
});
