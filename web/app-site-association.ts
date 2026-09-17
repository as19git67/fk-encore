import { api } from "encore.dev/api";
import { writeMaintenanceResponseIfActive } from "../backup/maintenance";
import { buildAppSiteAssociation, parseAppIds } from "./app-site-association-doc";

/**
 * Serves the Apple App Site Association document (#768 §5a). The document
 * itself and the rules for it live in `app-site-association-doc.ts`, which
 * has no Encore imports so the unit tests can load it without the runtime.
 */
export const appleAppSiteAssociation = api.raw(
  { expose: true, method: "GET", path: "/.well-known/apple-app-site-association" },
  async (_req, res) => {
    if (writeMaintenanceResponseIfActive(res)) return;
    const appIds = parseAppIds(process.env.APPLE_APP_IDS);
    if (appIds.length === 0) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end("Universal links are not configured (APPLE_APP_IDS is unset).");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    // Apple's CDN re-fetches on its own schedule; an hour keeps a changed
    // Team ID from being served stale for a day.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(JSON.stringify(buildAppSiteAssociation(appIds)));
  },
);
