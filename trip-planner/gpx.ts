/**
 * Writing a route out as GPX (§4.7).
 *
 * The planner is not a navigation app and will not become one. What it
 * can do is hand the way over to something that is: Komoot, Organic
 * Maps, a Garmin, Outdooractive. GPX is what all of them read, and it
 * is the only thing they all read.
 *
 * ## A track, not a route
 *
 * GPX has three kinds of thing and they are not interchangeable:
 *
 *   - `<wpt>` is a single point of interest;
 *   - `<rte>` is a list of points *to navigate between*, which invites
 *     the reading app to compute its own way from one to the next;
 *   - `<trk>` is a recorded course — this is where you went.
 *
 * A signposted way is a course. Written as a `<rte>`, Komoot would
 * route between the points with its own engine and quietly produce a
 * different way — one that may not be the signposted one at all. So it
 * is a `<trk>`, and the points are dense enough to be followed.
 *
 * ## Gaps stay gaps
 *
 * A relation whose members do not join up is written as several
 * `<trkseg>` in one `<trk>`. That is exactly what a track segment is
 * for, and it keeps the hole where the data has one: a single segment
 * drawn straight across would be a line nobody can walk, presented as
 * a way somebody signposted (§15.3).
 *
 * ## No elevation
 *
 * The relation carries an `ascent` tag, which is one number for the
 * whole way, and the geometry has no z. Writing `<ele>` would mean
 * inventing a profile. It is left out, and the total goes into the
 * description where it cannot be mistaken for a measurement per point.
 */

export interface GpxPoint {
  lat: number;
  lon: number;
}

export interface GpxTrack {
  /** What to call the track, and the basis of the file name. */
  name: string;
  /** hiking | foot | bicycle | mtb — written as the GPX `<type>`. */
  kind?: string;
  /** One array per connected part; several mean the way has gaps. */
  parts: GpxPoint[][];
  lengthM?: number | null;
  ascentM?: number | null;
  /** Where it came from, for the description line. */
  osmRef?: string | null;
  network?: string | null;
  ref?: string | null;
  /** A link the relation carries, written as a `<link>`. */
  website?: string | null;
  /** Fixed in tests; `new Date()` in production. */
  time?: Date;
}

/** Nothing to write: a relation whose geometry did not come through. */
export class EmptyTrackError extends Error {}

/**
 * Six decimal places — about eleven centimetres.
 *
 * More is noise from a source whose own accuracy is metres at best,
 * and it is what every other tool writes.
 */
const COORD_DECIMALS = 6;

/**
 * The GPX document for one route.
 *
 * Throws `EmptyTrackError` rather than writing a file with no points
 * in it: a zero-byte track that imports as an empty tour is worse than
 * being told there is nothing to export.
 */
export function buildGpx(track: GpxTrack): string {
  const parts = track.parts.filter((part) => part.length >= 2);
  if (parts.length === 0) {
    throw new EmptyTrackError("diese Strecke hat keinen Verlauf zum Exportieren");
  }

  const time = (track.time ?? new Date()).toISOString();
  const segments = parts
    .map((part) => `      <trkseg>\n${part.map(pointXml).join("\n")}\n      </trkseg>`)
    .join("\n");

  const head = [
    `        <name>${escapeXml(track.name)}</name>`,
    describe(track) ? `        <desc>${escapeXml(describe(track))}</desc>` : null,
    track.website ? `        <link href="${escapeXml(track.website)}" />` : null,
    track.kind ? `        <type>${escapeXml(track.kind)}</type>` : null,
  ].filter((line): line is string => line !== null).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="F4mil"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(track.name)}</name>
    <time>${time}</time>
    <desc>Aus OpenStreetMap, über F4mil. © OpenStreetMap-Mitwirkende, ODbL.</desc>
  </metadata>
  <trk>
${head}
${segments}
  </trk>
</gpx>
`;
}

/**
 * A file name somebody can find again.
 *
 * Built from the route's own name rather than its relation id: the
 * downloads folder is where this lands, and "relation-1234.gpx" is a
 * file nobody opens twice.
 */
export function gpxFilename(name: string): string {
  const slug = name
    .normalize("NFD")
    // Combining marks, so "Kösseine" becomes "Kosseine" rather than
    // "K-sseine".
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "strecke"}.gpx`;
}

/**
 * The one line of prose in the file: where it came from and what it
 * costs.
 *
 * Only what is known. A description reading "· ·" because two of three
 * numbers were missing is worse than a shorter one.
 */
function describe(track: GpxTrack): string {
  const parts: string[] = [];
  if (track.ref) parts.push(track.ref);
  if (track.network) parts.push(track.network.toUpperCase());
  if (typeof track.lengthM === "number") parts.push(kilometres(track.lengthM));
  if (typeof track.ascentM === "number" && track.ascentM > 0) {
    parts.push(`${track.ascentM} Hm Anstieg`);
  }
  if (track.parts.filter((p) => p.length >= 2).length > 1) {
    // Said in the file itself, because whoever opens it in six weeks
    // will not remember this conversation.
    parts.push("Verlauf in OpenStreetMap mit Lücken");
  }
  if (track.osmRef) parts.push(`OSM ${track.osmRef}`);
  return parts.join(" · ");
}

function kilometres(metres: number): string {
  if (metres < 1_000) return `${Math.round(metres)} m`;
  const km = metres / 1_000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1).replace(".", ",")} km`;
}

function pointXml(point: GpxPoint): string {
  const lat = point.lat.toFixed(COORD_DECIMALS);
  const lon = point.lon.toFixed(COORD_DECIMALS);
  return `        <trkpt lat="${lat}" lon="${lon}" />`;
}

/**
 * XML-escaping, on everything that comes from the map.
 *
 * A route name is a mapper's free text and has held an ampersand
 * before now; one unescaped character makes the whole file unreadable
 * to the app it was exported for.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
