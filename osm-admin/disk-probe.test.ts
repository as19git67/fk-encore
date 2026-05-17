import { describe, expect, it } from "vitest";
import { freeDiskMb, type StatfsFn } from "./disk-probe";

function statfsReturning(bsize: number | bigint, bavail: number | bigint): StatfsFn {
  return async () => ({ bsize, bavail });
}

describe("freeDiskMb", () => {
  it("converts statfs (bsize × bavail) to MB", async () => {
    expect(await freeDiskMb("/", statfsReturning(4096, 1_000_000))).toBe(4096);
  });

  it("handles BigInt fields (some Node versions return them)", async () => {
    expect(
      await freeDiskMb("/", statfsReturning(BigInt(4096), BigInt(2_000_000))),
    ).toBe(8192);
  });

  it("returns null when statfs throws", async () => {
    const failing: StatfsFn = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    expect(await freeDiskMb("/nope", failing)).toBeNull();
  });

  it("returns null on nonsense values (bsize 0)", async () => {
    expect(await freeDiskMb("/", statfsReturning(0, 1_000_000))).toBeNull();
  });

  it("returns null on negative free space", async () => {
    expect(await freeDiskMb("/", statfsReturning(4096, -1))).toBeNull();
  });
});
