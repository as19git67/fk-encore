import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listMusicTracks,
  moodForKind,
  pickTrackForRecap,
  resolveMusicFilePath,
  type MusicTrack,
} from "./recaps-music.service";

let dir: string;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "recap-music-"));
  const put = async (rel: string) => {
    const abs = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, "fake-audio");
  };
  await put("upbeat/01_sunny-road.mp3");
  await put("upbeat/02_open_skies.m4a");
  await put("warm/gentle-light.mp3");
  await put("nostalgic/old_letters.mp3");
  // Must all be ignored:
  await put("upbeat/notes.txt");
  await put("upbeat/.hidden.mp3");
  await put("unknown-mood/track.mp3");
});

afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("listMusicTracks", () => {
  it("scans mood folders, skips non-audio, hidden files and unknown moods", async () => {
    const tracks = await listMusicTracks(dir);
    expect(tracks.map((t) => t.id).sort()).toEqual([
      "nostalgic/old_letters.mp3",
      "upbeat/01_sunny-road.mp3",
      "upbeat/02_open_skies.m4a",
      "warm/gentle-light.mp3",
    ]);
  });

  it("derives readable titles and streaming URLs", async () => {
    const tracks = await listMusicTracks(dir);
    const sunny = tracks.find((t) => t.id === "upbeat/01_sunny-road.mp3")!;
    expect(sunny.title).toBe("Sunny Road");
    expect(sunny.mood).toBe("upbeat");
    expect(sunny.url).toBe("/recaps-music/file/upbeat/01_sunny-road.mp3");
  });

  it("returns an empty list for a missing directory", async () => {
    const tracks = await listMusicTracks(path.join(dir, "does-not-exist"));
    expect(tracks).toEqual([]);
  });
});

describe("moodForKind", () => {
  it("maps every recap kind to a mood", () => {
    expect(moodForKind("trip")).toBe("upbeat");
    expect(moodForKind("recent_highlights")).toBe("upbeat");
    expect(moodForKind("person")).toBe("warm");
    expect(moodForKind("on_this_day")).toBe("nostalgic");
    expect(moodForKind("place")).toBe("calm");
    expect(moodForKind("theme")).toBe("calm");
  });
});

describe("pickTrackForRecap", () => {
  it("is deterministic and prefers the kind's mood", async () => {
    const tracks = await listMusicTracks(dir);
    const a = pickTrackForRecap(tracks, "trip", 42);
    const b = pickTrackForRecap(tracks, "trip", 42);
    expect(a).toEqual(b);
    expect(a!.mood).toBe("upbeat");
  });

  it("falls back to the whole pool when the mood folder is empty", async () => {
    const tracks = await listMusicTracks(dir);
    // "calm" has no tracks in the fixture.
    const picked = pickTrackForRecap(tracks, "place", 7);
    expect(picked).not.toBeNull();
  });

  it("returns null without any tracks", () => {
    expect(pickTrackForRecap([] as MusicTrack[], "trip", 1)).toBeNull();
  });
});

describe("resolveMusicFilePath", () => {
  it("resolves an existing track", async () => {
    const p = await resolveMusicFilePath("warm/gentle-light.mp3", dir);
    expect(p).toBe(path.join(dir, "warm", "gentle-light.mp3"));
  });

  it("rejects traversal, unknown moods, hidden and non-audio files", async () => {
    expect(await resolveMusicFilePath("../etc/passwd", dir)).toBeNull();
    expect(await resolveMusicFilePath("warm/../../etc/passwd.mp3", dir)).toBeNull();
    expect(await resolveMusicFilePath("unknown-mood/track.mp3", dir)).toBeNull();
    expect(await resolveMusicFilePath("upbeat/.hidden.mp3", dir)).toBeNull();
    expect(await resolveMusicFilePath("upbeat/notes.txt", dir)).toBeNull();
    expect(await resolveMusicFilePath("upbeat/missing.mp3", dir)).toBeNull();
  });
});
