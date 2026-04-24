// Guest-facing comment endpoints for public album share-links.
//
// Mirrors photo/reactions.ts but authenticates via the guest session
// cookie (resolveGuest) instead of a bearer token, and delegates to
// the guest-variant functions in photo/reactions.service.ts.
//
// Write operations require a verified guest. Reads are allowed for
// unverified guests too — the share-page can show the conversation
// while the magic-link mail is still in flight.

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import {
  parseJsonBody,
  readBody,
  writeError,
  writeJson,
} from "./http";
import { resolveGuest } from "./guests.service";
import * as reactions from "../photo/reactions.service";

// GET /share/:token/photos/:photoId/comments
export const listGuestComments = api.raw(
  {
    expose: true,
    method: "GET",
    path: "/share/:token/photos/:photoId/comments",
    auth: false,
  },
  async (req, res) => {
    try {
      const { token, photoId } = extractShareAndPhotoId(req.url);
      const resolved = await resolveGuest(req, token);
      if (!resolved) throw APIError.unauthenticated("no guest session");
      const comments = await reactions.listCommentsForGuest(
        resolved.publicLink.id,
        photoId,
      );
      writeJson(res, 200, { comments });
    } catch (err) {
      writeError(res, err);
    }
  },
);

// POST /share/:token/photos/:photoId/comments
export const createGuestComment = api.raw(
  {
    expose: true,
    method: "POST",
    path: "/share/:token/photos/:photoId/comments",
    auth: false,
  },
  async (req, res) => {
    try {
      const { token, photoId } = extractShareAndPhotoId(req.url);
      const resolved = await resolveGuest(req, token);
      if (!resolved) throw APIError.unauthenticated("no guest session");
      if (!resolved.guest.verified_at) {
        throw APIError.permissionDenied(
          "E-Mail-Adresse bitte erst über den Bestätigungslink aus der Mail verifizieren.",
        );
      }
      const body = parseJsonBody<{ body?: string }>(await readBody(req));
      if (typeof body?.body !== "string") {
        throw APIError.invalidArgument("`body` (string) required");
      }
      const comment = await reactions.createCommentAsGuest(
        resolved.guest.id,
        photoId,
        body.body,
        resolved.publicLink.id,
      );
      writeJson(res, 200, comment);
    } catch (err) {
      writeError(res, err);
    }
  },
);

// PATCH /share/:token/comments/:commentId
export const updateGuestComment = api.raw(
  {
    expose: true,
    method: "PATCH",
    path: "/share/:token/comments/:commentId",
    auth: false,
  },
  async (req, res) => {
    try {
      const { token, commentId } = extractShareAndCommentId(req.url);
      const resolved = await resolveGuest(req, token);
      if (!resolved) throw APIError.unauthenticated("no guest session");
      if (!resolved.guest.verified_at) {
        throw APIError.permissionDenied("guest not verified");
      }
      const body = parseJsonBody<{ body?: string }>(await readBody(req));
      if (typeof body?.body !== "string") {
        throw APIError.invalidArgument("`body` (string) required");
      }
      const comment = await reactions.updateCommentAsGuest(
        resolved.guest.id,
        commentId,
        body.body,
        resolved.publicLink.id,
      );
      writeJson(res, 200, comment);
    } catch (err) {
      writeError(res, err);
    }
  },
);

// DELETE /share/:token/comments/:commentId
export const deleteGuestComment = api.raw(
  {
    expose: true,
    method: "DELETE",
    path: "/share/:token/comments/:commentId",
    auth: false,
  },
  async (req, res) => {
    try {
      const { token, commentId } = extractShareAndCommentId(req.url);
      const resolved = await resolveGuest(req, token);
      if (!resolved) throw APIError.unauthenticated("no guest session");
      if (!resolved.guest.verified_at) {
        throw APIError.permissionDenied("guest not verified");
      }
      const result = await reactions.deleteCommentAsGuest(
        resolved.guest.id,
        commentId,
        resolved.publicLink.id,
      );
      writeJson(res, 200, result);
    } catch (err) {
      writeError(res, err);
    }
  },
);

// ---------- Path parsing ----------

function extractShareAndPhotoId(url: string | undefined): {
  token: string;
  photoId: number;
} {
  if (!url) throw APIError.invalidArgument("missing url");
  const pathname = url.split("?")[0];
  // /share/:token/photos/:photoId/comments
  const m = pathname.match(/^\/share\/([^/]+)\/photos\/(\d+)\/comments$/);
  if (!m) throw APIError.invalidArgument("bad path");
  return { token: decodeURIComponent(m[1]), photoId: parseInt(m[2], 10) };
}

function extractShareAndCommentId(url: string | undefined): {
  token: string;
  commentId: number;
} {
  if (!url) throw APIError.invalidArgument("missing url");
  const pathname = url.split("?")[0];
  // /share/:token/comments/:commentId
  const m = pathname.match(/^\/share\/([^/]+)\/comments\/(\d+)$/);
  if (!m) throw APIError.invalidArgument("bad path");
  return { token: decodeURIComponent(m[1]), commentId: parseInt(m[2], 10) };
}

// Keep the logger binding referenced so tree-shakers don't drop the
// import (the service might grow to need it in follow-up etappes).
void log;
