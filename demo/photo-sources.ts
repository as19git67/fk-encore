/**
 * Where the demo photos come from (documentation/plans/demodaten.md,
 * stage 4): CC0 and Public Domain photos found through the Openverse API,
 * checked by the face detector, or — for the small demo, the tests and
 * whenever Openverse or the detector does not answer — pictures drawn here
 * from a few shapes.
 *
 * Openverse carries no "without people" filter. Candidates tagged with
 * people are passed over before downloading; every downloaded photo goes
 * through the face detector the app uses itself, and one with a
 * recognisable face (the photo book's rule) is dropped. CC0 photos of real
 * people still show real people.
 */

import sharp from "sharp";
import { RECOGNISABLE_FACE_MIN_AREA } from "../photo/photo-book-layout";
import { createRandom, type Random } from "./random";
import type { PhotoTopic } from "./photos";

/** The long edge the demo keeps of a downloaded photo: enough for the viewer, small on disk. */
export const MAX_EDGE = 2048;

export interface PhotoDeps {
  fetch: typeof fetch;
  openverseUrl: string;
  insightfaceUrl: string;
  /** Pause between two Openverse searches: anonymous clients get a small burst only. */
  searchPauseMs: number;
}

export function defaultPhotoDeps(): PhotoDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    openverseUrl: process.env.OPENVERSE_API_URL || "https://api.openverse.org",
    insightfaceUrl: process.env.INSIGHTFACE_SERVICE_URL || "http://localhost:8000",
    searchPauseMs: 3500,
  };
}

const USER_AGENT = "fk-encore-demo/1.0 (demo data generator; https://github.com/as19git67/fk-encore)";

/**
 * The search terms per topic, tried in turn: when one runs out of pages
 * the next one is searched. Short terms find more than long ones — a long
 * query only matches pictures that carry every word.
 */
export const OPENVERSE_QUERIES: Record<PhotoTopic, readonly string[]> = {
  beach: ["beach", "sea coast", "seaside", "sand dunes", "harbour boats"],
  mountains: ["mountains", "alps", "mountain lake", "summit", "valley"],
  snow: ["snow", "winter landscape", "snowy forest", "ski slope", "frost"],
  city: ["old town", "town square", "architecture", "street", "cathedral"],
  landscape: ["landscape", "countryside", "meadow", "forest", "lake"],
  garden: ["garden", "flowers", "roses", "tulips", "park"],
  food: ["food", "breakfast", "cake", "vegetables", "pasta"],
  animals: ["cat", "dog", "horse", "bird", "cows"],
  sports: ["bicycle", "hiking trail", "football", "sailing", "kayak"],
  celebration: ["birthday cake", "candles", "balloons", "party table", "champagne"],
  christmas: ["christmas tree", "christmas", "christmas market", "advent", "gingerbread"],
  fireworks: ["fireworks", "sparkler", "night sky", "new year", "lanterns"],
};

/** Tags that mean people are in the picture: such candidates are not even downloaded. */
const PEOPLE_TAGS = /\b(person|people|man|men|woman|women|girl|boy|child|children|kid|kids|portrait|face|selfie|crowd|family|baby|bride|groom|wedding|human)\b/i;

export interface OpenverseCandidate {
  id: string;
  title: string | null;
  creator: string | null;
  license: string;
  license_version: string | null;
  url: string;
  landing_url: string | null;
}

interface OpenverseResult {
  id: string;
  title?: string | null;
  creator?: string | null;
  license: string;
  license_version?: string | null;
  url: string;
  foreign_landing_url?: string | null;
  width?: number | null;
  height?: number | null;
  mature?: boolean;
  tags?: Array<{ name: string }> | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Why a request did not get through, in words for the Systemstatus card: the status code, or the network error's code. */
function failureReason(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError") return "keine Antwort in 10 s";
  return e?.cause?.code ?? e?.message ?? String(err);
}

/** Null when Openverse answers a search; otherwise why not ("HTTP 403", "ENOTFOUND", …). */
export async function openverseProblem(deps: PhotoDeps): Promise<string | null> {
  try {
    const res = await deps.fetch(`${deps.openverseUrl}/v1/images/?q=garden&license=cc0&page_size=1`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return failureReason(err);
  }
}

/** Null when the face detector answers its health check; otherwise why not. */
export async function faceDetectorProblem(deps: PhotoDeps): Promise<string | null> {
  try {
    const res = await deps.fetch(`${deps.insightfaceUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return failureReason(err);
  }
}

/** Keeps only what may be redistributed without attribution and shows no people by its tags. */
export function usableResult(r: OpenverseResult): boolean {
  if (r.license !== "cc0" && r.license !== "pdm") return false;
  if (r.mature) return false;
  if (r.width && r.height && Math.min(r.width, r.height) < 800) return false;
  const words = [r.title ?? "", ...(r.tags ?? []).map((t) => t.name)].join(" ");
  return !PEOPLE_TAGS.test(words);
}

/** One page of CC0/PDM results for a topic; an empty list when there are no more. Waits out a 429 up to three times. */
export async function searchOpenverse(
  deps: PhotoDeps,
  topic: PhotoTopic,
  page: number,
  query: string = OPENVERSE_QUERIES[topic][0],
): Promise<OpenverseCandidate[]> {
  const params = new URLSearchParams({
    q: query,
    license: "cc0,pdm",
    mature: "false",
    page_size: "20",
    page: String(page),
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await deps.fetch(`${deps.openverseUrl}/v1/images/?${params}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? "30");
      await sleep(Math.min(Math.max(wait, 1), 120) * 1000);
      continue;
    }
    // Openverse answers past the last page with 400 or an empty list.
    if (res.status === 400 || res.status === 404) return [];
    if (!res.ok) throw new Error(`Openverse antwortet mit ${res.status}`);
    const body = (await res.json()) as { results?: OpenverseResult[] };
    return (body.results ?? []).filter(usableResult).map((r) => ({
      id: r.id,
      title: r.title ?? null,
      creator: r.creator ?? null,
      license: r.license,
      license_version: r.license_version ?? null,
      url: r.url,
      landing_url: r.foreign_landing_url ?? null,
    }));
  }
  throw new Error("Openverse lässt keine weiteren Suchen zu (429)");
}

/**
 * Downloads a candidate and returns it as a JPEG with its long edge at most
 * `MAX_EDGE`, turned upright and without any of its metadata; `null` when
 * the download or the decoding fails.
 */
export async function downloadPhoto(deps: PhotoDeps, url: string): Promise<Buffer | null> {
  try {
    const res = await deps.fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    // sharp writes no metadata unless asked: EXIF, GPS and IPTC of the original are gone.
    return await sharp(raw)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** True when the face detector finds a face large enough to recognise someone. Throws when the detector fails. */
export async function hasRecognisableFace(deps: PhotoDeps, jpeg: Buffer): Promise<boolean> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "candidate.jpg");
  const res = await deps.fetch(`${deps.insightfaceUrl}/detect`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Gesichtserkennung antwortet mit ${res.status}`);
  const body = (await res.json()) as { faces?: Array<{ bbox: number[] }>; width: number; height: number };
  const area = body.width * body.height;
  if (!(area > 0)) return false;
  return (body.faces ?? []).some((f) => {
    const [x1, y1, x2, y2] = f.bbox;
    return ((x2 - x1) * (y2 - y1)) / area >= RECOGNISABLE_FACE_MIN_AREA;
  });
}

// ── drawn pictures ─────────────────────────────────────────────────────────

const W = 1600;
const H = 1200;

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`;
}

function sky(rnd: Random, night = false): string {
  const h = night ? 230 + rnd.int(0, 20) : 195 + rnd.int(0, 25);
  const top = night ? hsl(h, 50, 8) : hsl(h, 70, 55 + rnd.int(0, 10));
  const bottom = night ? hsl(h, 45, 20) : hsl(h + 10, 60, 82);
  return `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#sky)"/>`;
}

function hills(rnd: Random, base: number, hue: number, light: number, layers = 3): string {
  let out = "";
  for (let i = 0; i < layers; i++) {
    const y = base + i * 90;
    const pts: string[] = [`0,${H}`, `0,${y + rnd.int(-40, 40)}`];
    for (let x = 200; x <= W; x += 200) pts.push(`${x},${y + rnd.int(-90, 60)}`);
    pts.push(`${W},${H}`);
    out += `<polygon points="${pts.join(" ")}" fill="${hsl(hue + rnd.int(-10, 10), 40, light - i * 8)}"/>`;
  }
  return out;
}

function peaks(rnd: Random, snowy: boolean): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    const cx = rnd.int(0, W);
    const top = rnd.int(250, 450);
    const half = rnd.int(300, 520);
    out += `<polygon points="${cx - half},${H * 0.75} ${cx},${top} ${cx + half},${H * 0.75}" fill="${hsl(215, 12, 35 + i * 6)}"/>`;
    if (snowy) out += `<polygon points="${cx - half * 0.28},${top + 140} ${cx},${top} ${cx + half * 0.28},${top + 140}" fill="#fafafa"/>`;
  }
  return out;
}

function circles(rnd: Random, n: number, colors: string[], r: [number, number], area: [number, number, number, number]): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `<circle cx="${rnd.int(area[0], area[2])}" cy="${rnd.int(area[1], area[3])}" r="${rnd.int(r[0], r[1])}" fill="${rnd.pick(colors)}"/>`;
  }
  return out;
}

function scene(topic: PhotoTopic, rnd: Random): string {
  switch (topic) {
    case "beach":
      return sky(rnd) + `<circle cx="${rnd.int(200, 1400)}" cy="220" r="90" fill="#ffe28a"/>`
        + `<rect y="${H * 0.55}" width="${W}" height="${H * 0.2}" fill="${hsl(200, 70, 45)}"/>`
        + `<rect y="${H * 0.75}" width="${W}" height="${H * 0.25}" fill="${hsl(42, 60, 75)}"/>`;
    case "mountains":
      return sky(rnd) + peaks(rnd, rnd.chance(0.5)) + hills(rnd, H * 0.72, 110, 40, 2);
    case "snow":
      return sky(rnd) + peaks(rnd, true) + hills(rnd, H * 0.7, 210, 96, 2)
        + circles(rnd, 120, ["#ffffff"], [3, 7], [0, 0, W, H]);
    case "city": {
      let out = sky(rnd);
      for (let x = 0; x < W; x += rnd.int(90, 160)) {
        const h = rnd.int(300, 750);
        const w = rnd.int(80, 150);
        out += `<rect x="${x}" y="${H - h}" width="${w}" height="${h}" fill="${hsl(rnd.int(0, 40), 30, 40 + rnd.int(0, 30))}"/>`;
        for (let wy = H - h + 30; wy < H - 40; wy += 60) {
          out += `<rect x="${x + 15}" y="${wy}" width="${w - 30}" height="22" fill="${hsl(50, 30, 85)}" opacity="0.6"/>`;
        }
      }
      return out;
    }
    case "landscape":
      return sky(rnd) + `<circle cx="${rnd.int(200, 1400)}" cy="${rnd.int(150, 320)}" r="70" fill="#fff3b0"/>` + hills(rnd, H * 0.5, 100, 50, 4);
    case "garden":
      return sky(rnd) + `<rect y="${H * 0.45}" width="${W}" height="${H * 0.55}" fill="${hsl(110, 45, 38)}"/>`
        + circles(rnd, 90, ["#e63946", "#f4a261", "#ffd166", "#c77dff", "#ffffff", "#ff70a6"], [12, 34], [0, Math.round(H * 0.5), W, H]);
    case "food":
      return `<rect width="${W}" height="${H}" fill="${hsl(rnd.int(20, 40), 35, 60)}"/>`
        + `<circle cx="${W / 2}" cy="${H / 2}" r="430" fill="#f8f8f4"/><circle cx="${W / 2}" cy="${H / 2}" r="330" fill="#ececE6"/>`
        + circles(rnd, 26, ["#d62828", "#2a9d8f", "#e9c46a", "#8d5524", "#f77f00"], [25, 70], [W / 2 - 230, H / 2 - 230, W / 2 + 230, H / 2 + 230]);
    case "animals":
      return `<rect width="${W}" height="${H}" fill="${hsl(110, 40, 45)}"/>`
        + `<ellipse cx="${W / 2}" cy="${H * 0.6}" rx="330" ry="190" fill="${rnd.pick(["#8d5524", "#3d3d3d", "#e0a96d", "#f2f2f2"])}"/>`
        + `<circle cx="${W / 2 + 310}" cy="${H * 0.45}" r="120" fill="${rnd.pick(["#6b4226", "#2b2b2b", "#c98b4f"])}"/>`;
    case "sports":
      return sky(rnd) + hills(rnd, H * 0.55, 95, 45, 2)
        + `<path d="M0,${H} C${W * 0.3},${H * 0.75} ${W * 0.6},${H * 0.85} ${W},${H * 0.62}" stroke="${hsl(35, 30, 70)}" stroke-width="60" fill="none"/>`;
    case "celebration":
      return `<rect width="${W}" height="${H}" fill="${hsl(rnd.int(280, 340), 35, 30)}"/>`
        + circles(rnd, 18, ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93"], [50, 90], [100, 100, W - 100, H * 0.55])
        + `<rect x="${W / 2 - 260}" y="${H * 0.62}" width="520" height="260" rx="30" fill="#fbe7c6"/>`;
    case "christmas":
      return `<rect width="${W}" height="${H}" fill="${hsl(25, 40, 18)}"/>`
        + `<polygon points="${W / 2 - 380},${H * 0.9} ${W / 2},100 ${W / 2 + 380},${H * 0.9}" fill="${hsl(140, 50, 25)}"/>`
        + circles(rnd, 40, ["#ffd166", "#ef476f", "#f8f9fa", "#ffb703"], [10, 22], [W / 2 - 300, 220, W / 2 + 300, H * 0.85]);
    case "fireworks": {
      let out = sky(rnd, true);
      for (let i = 0; i < 6; i++) {
        const cx = rnd.int(200, W - 200);
        const cy = rnd.int(150, 650);
        const color = rnd.pick(["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#ffffff"]);
        for (let a = 0; a < 360; a += 15) {
          const r = rnd.int(120, 220);
          const x = cx + Math.cos((a * Math.PI) / 180) * r;
          const y = cy + Math.sin((a * Math.PI) / 180) * r;
          out += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(0)}" y2="${y.toFixed(0)}" stroke="${color}" stroke-width="4"/>`;
        }
      }
      return out;
    }
  }
}

/** A picture of the topic drawn from a few shapes, the same for the same seed. JPEG, 1600×1200. */
export async function drawPhoto(topic: PhotoTopic, seed: number): Promise<Buffer> {
  const rnd = createRandom(seed);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${scene(topic, rnd)}</svg>`;
  return await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}
