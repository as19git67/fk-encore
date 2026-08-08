import { describe, it, expect } from "vitest";
import {
  describeConnectionTarget,
  isTransientConnectionError,
  resolveConnectRetryBudgetMs,
} from "./database";

const withCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

describe("isTransientConnectionError", () => {
  it("detects a raw socket error", () => {
    expect(isTransientConnectionError(withCode("connect", "ECONNREFUSED"))).toBe(true);
    expect(isTransientConnectionError(withCode("connect", "ETIMEDOUT"))).toBe(true);
    expect(isTransientConnectionError(withCode("dns", "ENOTFOUND"))).toBe(true);
  });

  it("detects Postgres connection-class and shutdown SQLSTATEs", () => {
    expect(isTransientConnectionError(withCode("conn", "08006"))).toBe(true);
    expect(isTransientConnectionError(withCode("admin shutdown", "57P01"))).toBe(true);
    expect(isTransientConnectionError(withCode("crash shutdown", "57P02"))).toBe(true);
    expect(isTransientConnectionError(withCode("in recovery mode", "57P03"))).toBe(true);
  });

  it("unwraps a pg error buried in a DrizzleQueryError-style cause chain", () => {
    const driverErr = withCode("the database system is in recovery mode", "57P03");
    const wrapped = Object.assign(new Error("Failed query: UPDATE finance_tag_queue"), {
      cause: driverErr,
    });
    expect(isTransientConnectionError(wrapped)).toBe(true);
  });

  it("treats a plain query error as non-transient", () => {
    expect(isTransientConnectionError(withCode("syntax error", "42601"))).toBe(false);
    expect(isTransientConnectionError(withCode("unique violation", "23505"))).toBe(false);
    expect(isTransientConnectionError(new Error("boom"))).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});

describe("resolveConnectRetryBudgetMs", () => {
  it("retries forever outside tests", () => {
    expect(resolveConnectRetryBudgetMs({})).toBe(0);
    expect(resolveConnectRetryBudgetMs({ NODE_ENV: "production" })).toBe(0);
  });

  it("bounds the wait under test, where a bad host cannot fix itself", () => {
    expect(resolveConnectRetryBudgetMs({ NODE_ENV: "test" })).toBeGreaterThan(0);
    expect(resolveConnectRetryBudgetMs({ VITEST: "true" })).toBeGreaterThan(0);
  });

  it("honours an explicit budget, including 0 for unlimited", () => {
    expect(
      resolveConnectRetryBudgetMs({ DB_CONNECT_RETRY_BUDGET_MS: "5000" }),
    ).toBe(5000);
    // Explicit 0 must win over the test default, not fall back to it.
    expect(
      resolveConnectRetryBudgetMs({
        NODE_ENV: "test",
        DB_CONNECT_RETRY_BUDGET_MS: "0",
      }),
    ).toBe(0);
  });

  it("ignores unusable values and falls back", () => {
    for (const raw of ["", "   ", "abc", "-1"]) {
      expect(
        resolveConnectRetryBudgetMs({
          NODE_ENV: "production",
          DB_CONNECT_RETRY_BUDGET_MS: raw,
        }),
      ).toBe(0);
    }
  });
});

describe("describeConnectionTarget", () => {
  it("reports host, port and database", () => {
    expect(
      describeConnectionTarget("postgres://user:pw@db.example:6543/fk_encore"),
    ).toBe("db.example:6543/fk_encore");
  });

  it("defaults the port when the URL omits it", () => {
    expect(
      describeConnectionTarget("postgres://user:pw@localhost/encore_test"),
    ).toBe("localhost:5432/encore_test");
  });

  it("never leaks the password", () => {
    const described = describeConnectionTarget(
      "postgres://user:hunter2@localhost:5432/encore_test",
    );
    expect(described).not.toContain("hunter2");
    expect(described).not.toContain("user");
  });

  it("degrades gracefully on an unparseable string", () => {
    expect(describeConnectionTarget("not a url")).toBe(
      "(unparseable connection string)",
    );
  });
});
