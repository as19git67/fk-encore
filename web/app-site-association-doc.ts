/**
 * Apple App Site Association (#768 §5a).
 *
 * iOS opens a `https://<this host>/app/…` link in the F4mil Photos app
 * instead of Safari only when this host publishes a JSON document at
 * `/.well-known/apple-app-site-association` that names the app and the
 * paths it claims. The app carries the matching `applinks:<host>`
 * entitlement (`ios/App/FKPhotos.entitlements`).
 *
 * Which app may claim the links is deployment configuration, not code: the
 * document names the Apple Team ID plus bundle id of whoever builds the app
 * for this household. With `APPLE_APP_IDS` unset the endpoint answers 404,
 * and links simply keep opening in the browser.
 *
 * Apple's requirements, all of which this endpoint meets:
 * - served over HTTPS at exactly that path, no redirect;
 * - `Content-Type: application/json`;
 * - no more than 128 KB.
 */

/** `TEAMID.bundle.id`, one or more — Apple's own format for app identifiers. */
const APP_ID_PATTERN = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;

/**
 * The app IDs a deployment allows, parsed from a comma-separated list.
 * Entries that do not look like `TEAMID.bundle.id` are dropped, since Apple
 * rejects the whole file over one malformed entry, which is harder to notice
 * than a missing one.
 */
export function parseAppIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => APP_ID_PATTERN.test(s));
}

/**
 * The paths the iOS app takes over. Mirrors `AppDeepLink.parseWebURL` in
 * `ios/Sources/FKPhotos/App/AppDeepLink.swift`: whatever is claimed here
 * must have an in-app target there, or a tap opens the app on the screen it
 * happened to be showing. Everything else — documents, finance, settings,
 * the plain gallery — stays in the browser.
 *
 * `components` is the iOS 13+ format; `?` matches on query parameters,
 * which is how a photo link (`/app/fotos/galerie?photoId=…`) is claimed
 * without taking the bare gallery with it.
 */
export const CLAIMED_COMPONENTS: ReadonlyArray<Record<string, unknown>> = [
  { "/": "/app/fotos/alben/*", comment: "Album" },
  { "/": "/app/albums/*", comment: "Album (legacy route) and shared-album links" },
  { "/": "/app/fotos/personen", "?": { personId: "*" }, comment: "Person" },
  { "/": "/app/fotos/rueckblicke", comment: "Recaps, with or without recapId" },
  { "/": "/app/fotos/feed", comment: "Feed" },
  { "/": "/app/fotos/review-queue", comment: "Group review" },
  { "/": "/app/fotos/galerie", "?": { photoId: "*" }, comment: "Photo" },
  { "/": "/app/photos", "?": { photoId: "*" }, comment: "Photo (legacy route)" },
  { "/": "/app/fotos", "?": { photoId: "*" }, comment: "Photo (module root)" },
];

/** The document itself. Pure, so the shape is testable. */
export function buildAppSiteAssociation(appIds: string[]): Record<string, unknown> {
  return {
    applinks: {
      details: [
        {
          appIDs: appIds,
          components: CLAIMED_COMPONENTS.map((c) => ({ ...c })),
        },
      ],
    },
  };
}

