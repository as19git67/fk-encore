/**
 * Photos of the house handbook (documentation/plans/haus-anlagen.md, stage 2).
 *
 *   POST   /home/systems/:id/media?target=note&targetId=5   upload (raw body)  home.manage
 *   POST   /home/parts/:id/media                            photo of a part    home.manage
 *   GET    /home/media/:id/file?size=small|full             the JPEG           home.view
 *   PATCH  /home/media/:id                                  caption            home.manage
 *   DELETE /home/media/:id                                                     home.manage
 *
 * The file endpoint is what an `<img src>` loads, so it also takes the
 * `?token=` credential (media scope, read-only). The upload takes the raw
 * image bytes as body, like the meter photos.
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { dailyAtUtc, schedule } from "../lib/local-cron";
import { requirePermission } from "../user/auth-handler";
import { MAX_UPLOAD_BYTES, sweepHomeMedia, type HomeMedia } from "./media-store";
import {
  deleteMedia,
  mediaFile,
  parseTargetKind,
  updateMediaCaption,
  uploadMedia,
  uploadPartMedia,
} from "./media.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

const HTTP_STATUS: Record<string, number> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
};

function sendError(res: ServerResponse, err: unknown): void {
  const code = err instanceof APIError ? err.code : "internal";
  const status = HTTP_STATUS[code] ?? 500;
  if (status === 500) console.error("[home] media error:", err);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code, message: status === 500 ? "internal error" : (err as Error).message }));
}

class TooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new TooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** The body, or a 413 already sent (then `null`). */
async function readUpload(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  try {
    return await readBody(req);
  } catch (err) {
    if (err instanceof TooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "invalid_argument", message: "Das Foto ist größer als 30 MB." }));
      return null;
    }
    throw err;
  }
}

export const uploadHomeMedia = api.raw(
  { expose: true, method: "POST", path: "/home/systems/:id/media", auth: true, bodyLimit: null },
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const userId = requireUser("home.manage");
      const url = new URL(req.url ?? "", "http://local");
      const systemId = Number(/\/home\/systems\/(\d+)\/media/.exec(url.pathname)?.[1]);
      if (!Number.isInteger(systemId) || systemId <= 0) throw APIError.invalidArgument("invalid system id");
      const targetKind = parseTargetKind(url.searchParams.get("target"));
      const targetId = targetKind === "system" ? systemId : Number(url.searchParams.get("targetId"));
      if (!Number.isInteger(targetId) || targetId <= 0) throw APIError.invalidArgument("invalid targetId");
      const bytes = await readUpload(req, res);
      if (!bytes) return;
      const media = await uploadMedia(userId, systemId, {
        targetKind,
        targetId,
        caption: url.searchParams.get("caption"),
        bytes,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(media));
    } catch (err) {
      sendError(res, err);
    }
  },
);

export const uploadHomePartMedia = api.raw(
  { expose: true, method: "POST", path: "/home/parts/:id/media", auth: true, bodyLimit: null },
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const userId = requireUser("home.manage");
      const url = new URL(req.url ?? "", "http://local");
      const partId = Number(/\/home\/parts\/(\d+)\/media/.exec(url.pathname)?.[1]);
      if (!Number.isInteger(partId) || partId <= 0) throw APIError.invalidArgument("invalid part id");
      const bytes = await readUpload(req, res);
      if (!bytes) return;
      const media = await uploadPartMedia(userId, partId, { caption: url.searchParams.get("caption"), bytes });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(media));
    } catch (err) {
      sendError(res, err);
    }
  },
);

export const homeMediaFile = api.raw(
  { expose: true, method: "GET", path: "/home/media/:id/file", auth: true },
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const userId = requireUser("home.view");
      const url = new URL(req.url ?? "", "http://local");
      const mediaId = Number(/\/home\/media\/(\d+)\/file/.exec(url.pathname)?.[1]);
      if (!Number.isInteger(mediaId) || mediaId <= 0) throw APIError.invalidArgument("invalid photo id");
      const size = url.searchParams.get("size") === "small" ? "small" : "full";
      const file = await mediaFile(userId, mediaId, size);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(file.bytes),
        // A photo never changes under its id; only the caller may keep it.
        "Cache-Control": "private, max-age=86400, immutable",
      });
      const stream = fs.createReadStream(file.path);
      stream.on("error", () => res.end());
      stream.pipe(res);
    } catch (err) {
      sendError(res, err);
    }
  },
);

interface CaptionRequest {
  id: number;
  caption: string | null;
}

export const updateHomeMedia = api(
  { expose: true, method: "PATCH", path: "/home/media/:id", auth: true },
  async (req: CaptionRequest): Promise<HomeMedia> => {
    const userId = requireUser("home.manage");
    return await updateMediaCaption(userId, req.id, req.caption);
  },
);

export const deleteHomeMedia = api(
  { expose: true, method: "DELETE", path: "/home/media/:id", auth: true },
  async ({ id }: { id: number }): Promise<void> => {
    const userId = requireUser("home.manage");
    await deleteMedia(userId, id);
  },
);

schedule({
  name: "home-media-sweep",
  description: "Remove house handbook photos whose guide, item, note or part is gone, and files no photo names",
  service: "home",
  scheduleLabel: "daily 02:40 UTC",
  nextFire: dailyAtUtc(2, 40),
  run: async () => {
    const result = await sweepHomeMedia();
    if (result.rows || result.files) {
      console.log(`[home] media sweep removed ${result.rows} row(s) and ${result.files} file(s)`);
    }
  },
});
