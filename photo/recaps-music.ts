/**
 * Rueckblick-Musik — API-Endpoints.
 *
 * `GET /recaps/music` listet alle verfuegbaren Tracks; das Streaming laeuft
 * ueber einen Raw-Endpoint mit Range-Support, damit sowohl das <audio>-
 * Element (Safari verlangt Range-Requests) als auch AVAudioPlayer sauber
 * abspielen koennen. Der Datei-Endpoint ist wie /photos/file/* nicht
 * authentifiziert — die Track-Pfade sind nicht erratbar-sensibel und die
 * Clients haengen die URL direkt in Audio-Elemente, die keine Header
 * mitschicken koennen.
 */

import * as fs from "fs";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  audioMimeType,
  listMusicTracks,
  resolveMusicFilePath,
  type MusicTrack,
} from "./recaps-music.service";

interface ListMusicResponse {
  tracks: MusicTrack[];
}

/** List all available recap music tracks, grouped by mood via `track.mood`. */
// Note: paths live under /recaps-music (not /recaps/music) so the GET route
// cannot collide with the parameterised GET /recaps/:id.
export const listRecapMusic = api(
  { expose: true, method: "GET", path: "/recaps-music", auth: true },
  async (): Promise<ListMusicResponse> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "module.photos");
    requirePermission(authData, "photos.view");
    const tracks = await listMusicTracks();
    return { tracks };
  }
);

/**
 * Stream a music track. Supports single-range requests (`Range: bytes=a-b`)
 * because Safari's <audio> element and AVFoundation probe with ranges and
 * refuse to play from servers that ignore them.
 */
export const getRecapMusicFile = api.raw(
  { expose: true, method: "GET", path: "/recaps-music/file/*track", auth: false },
  async (req, res) => {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const rawPath = decodeURIComponent(
        url.pathname.replace(/^\/recaps-music\/file\//, "")
      );

      const filePath = await resolveMusicFilePath(rawPath);
      if (!filePath) {
        res.statusCode = 404;
        res.end("Track not found");
        return;
      }

      const mimeType = audioMimeType(filePath) ?? "application/octet-stream";
      const stat = await fs.promises.stat(filePath);
      const total = stat.size;

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Accept-Ranges", "bytes");
      // Tracks are immutable once dropped into the folder; let clients cache.
      res.setHeader("Cache-Control", "public, max-age=86400");

      const rangeHeader = req.headers.range;
      const match =
        typeof rangeHeader === "string"
          ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
          : null;

      if (match && (match[1] !== "" || match[2] !== "")) {
        let start: number;
        let end: number;
        if (match[1] === "") {
          // suffix range: last N bytes
          const suffix = parseInt(match[2], 10);
          if (suffix === 0) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${total}`);
            res.end();
            return;
          }
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = parseInt(match[1], 10);
          end = match[2] === "" ? total - 1 : parseInt(match[2], 10);
        }
        if (start >= total || end < start) {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${total}`);
          res.end();
          return;
        }
        end = Math.min(end, total - 1);
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", end - start + 1);
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Length", total);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error("Error serving recap music:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal server error");
      } else {
        res.end();
      }
    }
  }
);
