/**
 * Reading the height model's answer (§7.3).
 *
 * The whole risk here is positional: the elevations come back as a bare
 * array aligned with the coordinates that were sent, so a short or
 * ragged answer must not shift every height onto the wrong bearing.
 */

import { describe, expect, it } from "vitest";
import { ELEVATION_BATCH, ElevationUnavailableError, parseElevations } from "./elevation-client";

describe("parseElevations", () => {
  it("reads the elevations in order", () => {
    expect(parseElevations({ elevation: [500, 512.5, 480] }, 3)).toEqual([500, 512.5, 480]);
  });

  it("turns a hole into null rather than sea level", () => {
    expect(parseElevations({ elevation: [500, null, "x", 480] }, 4))
      .toEqual([500, null, null, 480]);
  });

  it("pads a short answer so nothing shifts", () => {
    expect(parseElevations({ elevation: [500, 510] }, 4)).toEqual([500, 510, null, null]);
  });

  it("ignores extra values", () => {
    expect(parseElevations({ elevation: [500, 510, 520] }, 2)).toEqual([500, 510]);
  });

  it("refuses an answer without the array", () => {
    expect(() => parseElevations({}, 1)).toThrow(ElevationUnavailableError);
    expect(() => parseElevations(null, 1)).toThrow(ElevationUnavailableError);
  });

  it("batches at the size the service accepts", () => {
    expect(ELEVATION_BATCH).toBe(100);
  });
});
