/**
 * Google's encoded polyline, as Valhalla writes it (§24).
 *
 * Valhalla returns a route's shape as a polyline with six decimal
 * places (`shape_format: polyline6`, its default), not Google's five.
 * Decoding with the wrong precision puts the road ten times too far
 * from where it is, which is exactly the kind of error that looks like
 * a working corridor until somebody compares it with a map.
 */

import type { Coordinate } from "./travel";

/** Decode a polyline into coordinates; `precision` is the decimal places. */
export function decodePolyline(encoded: string, precision = 6): Coordinate[] {
  const factor = 10 ** precision;
  const points: Coordinate[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    const dLat = readVarint();
    if (dLat === null) break;
    const dLon = readVarint();
    if (dLon === null) break;
    lat += dLat;
    lon += dLon;
    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points;

  function readVarint(): number | null {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}

/**
 * Keep every `step`-th point plus the last one: a motorway shape has a
 * point every few metres, and a corridor needs the line, not the
 * centimetres. Both ends always survive.
 */
export function thinPolyline(points: readonly Coordinate[], maxPoints: number): Coordinate[] {
  if (points.length <= maxPoints || maxPoints < 2) return [...points];
  const step = (points.length - 1) / (maxPoints - 1);
  const out: Coordinate[] = [];
  for (let i = 0; i < maxPoints - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}
