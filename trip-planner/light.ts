/**
 * From "where the sun is" to "what this spot looks like then" (§7.3).
 *
 * The sun's position on its own is a generality: it is the same for
 * every spot in the city and helps nobody choose between two of them.
 * What turns it into a statement is the one thing the sky does not
 * know — which way the building faces. The import computes that once
 * per outline (`geo/src/facade-azimuth.ts`) and stores it, so at
 * planning time this is a comparison of two angles.
 *
 * **The azimuth is deliberately ambiguous, and so is the answer here.**
 * A wall running east–west faces either north or south, and an outline
 * cannot say which; the column therefore folds both into [0, 180). So
 * this module never claims *which* face is lit — it says that the sun
 * stands square to the building, which means one long face is in full
 * light and the other in shade, and the person standing there can see
 * which is which in a second. Claiming more would be inventing the half
 * of the geometry that was never imported (§15.3).
 */

import { solarPosition, type Coordinate, type LightWindow } from "./sun";

/**
 * How the sun meets the building's long faces.
 *
 * - `frontal` — square to them: one face fully lit, the other in shade.
 * - `raking` — across them at an angle: the light that shows texture,
 *   mouldings and brickwork.
 * - `edge_on` — along them: both faces are grazed at best, and a
 *   photograph of either is flat.
 */
export type FacadeLight = "frontal" | "raking" | "edge_on";

/** Where `frontal` ends and `raking` begins, in degrees. */
const FRONTAL_LIMIT = 30;
/** Where `raking` ends and `edge_on` begins. */
const RAKING_LIMIT = 60;

/**
 * How the sun at `sunAzimuth` meets a facade whose normal is
 * `facadeAzimuth`, or null when the spot has no known orientation.
 *
 * Null is the common case and not a failure: only areas carry an
 * outline, so every POI mapped as a node — most churches' entrances,
 * every viewpoint, most cafés — answers nothing here, and the screen
 * simply says less about them.
 */
export function facadeLight(
  facadeAzimuth: number | null | undefined,
  sunAzimuth: number,
): FacadeLight | null {
  if (facadeAzimuth === null || facadeAzimuth === undefined) return null;
  if (!Number.isFinite(facadeAzimuth) || !Number.isFinite(sunAzimuth)) return null;

  // Both folded into a half-turn, because a facade normal of 10° and one
  // of 190° describe the same pair of walls.
  const difference = Math.abs(fold(sunAzimuth) - fold(facadeAzimuth));
  const separation = Math.min(difference, 180 - difference);

  if (separation <= FRONTAL_LIMIT) return "frontal";
  if (separation <= RAKING_LIMIT) return "raking";
  return "edge_on";
}

function fold(degrees: number): number {
  return ((degrees % 180) + 180) % 180;
}

export interface SpotLight {
  window: LightWindow;
  /** How the sun meets the facade in the middle of the window. */
  facade: FacadeLight | null;
}

/**
 * The windows of a day as they apply to one spot, best first.
 *
 * The facade verdict is taken at the **middle** of the window rather
 * than at its edges: near sunrise and sunset the azimuth swings
 * quickly, and either edge would answer for a minute nobody is
 * standing there.
 *
 * Ordering is by usefulness, not by clock: a golden window that stands
 * square to the building is the one worth naming, and the harsh middle
 * of the day comes last because it is a caveat rather than an
 * invitation.
 */
export function spotLight(
  at: Coordinate,
  windows: readonly LightWindow[],
  facadeAzimuth: number | null | undefined,
): SpotLight[] {
  const lit = windows.map((window) => ({
    window,
    facade: facadeLight(facadeAzimuth, sunAzimuthAtMiddleOf(at, window)),
  }));
  return lit.sort((a, b) => rank(a) - rank(b) || a.window.fromMinutes - b.window.fromMinutes);
}

function sunAzimuthAtMiddleOf(at: Coordinate, window: LightWindow): number {
  const middle = (Date.parse(window.from) + Date.parse(window.to)) / 2;
  return solarPosition(at, new Date(middle)).azimuth;
}

/** Lower sorts earlier. */
function rank({ window, facade }: SpotLight): number {
  if (window.kind === "harsh") return 4;
  const base = window.kind === "golden" ? 0 : 2;
  // A window that lights the building beats one that grazes it, and
  // both beat one that runs along the wall. An unknown orientation
  // sits in the middle: it is not a reason to demote a golden hour.
  if (facade === "frontal") return base;
  if (facade === "edge_on") return base + 1;
  return base + 0.5;
}
