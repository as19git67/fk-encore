/**
 * HTTP entry point for the virtualized photo gallery grid.
 *
 * GET /gallery/grid – returns a window of pre-enriched grid rows plus
 * `total` and `offset`, designed so the frontend can drive a
 * virtualized scroller without ever iterating the full library client-
 * side. See `gallery-grid.service.ts` for the SQL/logic.
 */
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { Query } from "encore.dev/api";
import { requirePermission } from "../user/auth-handler";
import { isInBackupMode } from "../backup/state";
import { parsePhotoFilterQuery, type PhotoFilterQuery } from "./photo.filters";
import {
  listGalleryGridLogic,
  normalizeGallerySortDir,
  normalizeGallerySortField,
} from "./gallery-grid.service";
import type { GalleryGridResponse } from "../db/types";

/**
 * Filter + pagination + sort query parameters. Mirrors the legacy
 * /photos/index params for filters so the existing FilterMenu can be
 * reused later, but keeps pagination strictly required (limit >= 1) so
 * the endpoint always returns total/offset.
 */
type GalleryGridQueryParams = {
  // — filters (mirror photo.filters) —
  hiddenMode?: Query<string>;
  favorite?: Query<boolean>;
  albumHighlight?: Query<boolean>;
  groupHighlight?: Query<boolean>;
  inGroup?: Query<boolean>;
  othersFavorited?: Query<boolean>;
  othersHidden?: Query<boolean>;
  qualityMin?: Query<number>;
  qualityMax?: Query<number>;
  notInAnyAlbum?: Query<boolean>;
  albumIds?: Query<string>;
  albumMode?: Query<string>;
  personIds?: Query<string>;
  personMode?: Query<string>;
  mediaTypes?: Query<string>;
  hasGps?: Query<boolean>;
  hasFaces?: Query<boolean>;
  hasAssignedPerson?: Query<boolean>;
  dateFrom?: Query<string>;
  dateTo?: Query<string>;
  importedDaysAgo?: Query<number>;
  sizeMin?: Query<number>;
  sizeMax?: Query<number>;

  // — pagination —
  /** Required. Number of rows to return. Server caps at MAX_LIMIT. */
  limit?: Query<number>;
  /** Page offset. Wins over `aroundPhotoId` when both are supplied. */
  offset?: Query<number>;
  /**
   * If supplied (and `offset` is not), the server centers the window on
   * this photo: it locates the photo's position in the filtered+sorted
   * result and clamps the page offset so the photo sits near the middle.
   */
  aroundPhotoId?: Query<number>;

  // — sort —
  sortBy?: Query<string>;
  sortDir?: Query<string>;
};

function toFilterQuery(p: GalleryGridQueryParams): PhotoFilterQuery {
  return {
    hiddenMode: p.hiddenMode,
    favorite: p.favorite,
    albumHighlight: p.albumHighlight,
    groupHighlight: p.groupHighlight,
    inGroup: p.inGroup,
    othersFavorited: p.othersFavorited,
    othersHidden: p.othersHidden,
    qualityMin: p.qualityMin,
    qualityMax: p.qualityMax,
    notInAnyAlbum: p.notInAnyAlbum,
    albumIds: p.albumIds,
    albumMode: p.albumMode,
    personIds: p.personIds,
    personMode: p.personMode,
    mediaTypes: p.mediaTypes,
    hasGps: p.hasGps,
    hasFaces: p.hasFaces,
    hasAssignedPerson: p.hasAssignedPerson,
    dateFrom: p.dateFrom,
    dateTo: p.dateTo,
    importedDaysAgo: p.importedDaysAgo,
    sizeMin: p.sizeMin,
    sizeMax: p.sizeMax,
  };
}

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 2000;

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID);
}

export const listGalleryGrid = api(
  { expose: true, method: "GET", path: "/gallery/grid", auth: true },
  async (params: GalleryGridQueryParams): Promise<GalleryGridResponse> => {
    // Maintenance gate — same backoff signal /photos/* uses while the
    // backup snapshot is being captured.
    if (isInBackupMode()) {
      throw APIError.unavailable("Wartungsmodus aktiv – bitte später nochmal versuchen.");
    }

    const authData = getAuthData()!;
    requirePermission(authData, "module.photos");
    requirePermission(authData, "photos.view");
    const userId = getUserId();

    const filter = parsePhotoFilterQuery(toFilterQuery(params));

    const limit = typeof params.limit === "number" && params.limit > 0
      ? Math.min(params.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;
    const offset = typeof params.offset === "number" && params.offset > 0
      ? params.offset
      : undefined;
    const aroundPhotoId =
      offset === undefined &&
      typeof params.aroundPhotoId === "number" &&
      params.aroundPhotoId > 0
        ? params.aroundPhotoId
        : undefined;

    const sortBy = normalizeGallerySortField(params.sortBy);
    const sortDir = normalizeGallerySortDir(params.sortDir);

    return await listGalleryGridLogic(userId, filter, {
      limit,
      offset,
      aroundPhotoId,
      sortBy,
      sortDir,
    });
  },
);
