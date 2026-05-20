import { describe, it, expect } from "vitest";
import { isTransientConnectionError } from "./database";

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
