/**
 * What the asking user may and may not use, as the model reads it (#1648).
 *
 * The catalog already holds only the tools the user may call, so a model
 * without finance tools never sees one. What it did not know is *why*:
 * asked for an account balance, it said "Im System sind keine Konten
 * angelegt" — true of what it could see, and wrong. The user could not
 * tell missing data from a missing permission.
 *
 * So the prompt names the areas, granted and not, by the same permissions
 * the tools ask for. This is information for the model and never a grant:
 * the catalog, the tool run and the services still check every call.
 *
 * Only whole areas are named. Inside an area the services filter on their
 * own (shared accounts, photos of others), and saying "you lack access to
 * an account" there would tell the user that such an account exists.
 */

/** An area of the server, the permissions its read tools need, and how the model should name it. */
interface AccessArea {
  label: string;
  permissions: string[];
}

export const ACCESS_AREAS: AccessArea[] = [
  { label: "Finanzen (accounts, bookings, payments, depot, quotes, businesses)", permissions: ["module.finance", "finance.view"] },
  { label: "Dokumente (documents, tax documents, letters)", permissions: ["module.documents", "documents.view"] },
  { label: "Fotos (photos, albums, people, trip plans)", permissions: ["module.photos", "photos.view"] },
  { label: "Zähler (utility meters, readings, consumption)", permissions: ["module.meters", "meters.view"] },
];

export interface UserAccess {
  granted: string[];
  missing: string[];
}

export function userAccess(permissions: readonly string[]): UserAccess {
  const held = new Set(permissions);
  const granted: string[] = [];
  const missing: string[] = [];
  for (const area of ACCESS_AREAS) {
    (area.permissions.every((p) => held.has(p)) ? granted : missing).push(area.label);
  }
  return { granted, missing };
}

/** The prompt section; the write tools are named by the catalog that offers them. */
export function accessSection(access: UserAccess, writeTools: string[]): string {
  const lines = ["Access of this user:"];
  lines.push(`- May use: ${access.granted.length ? access.granted.join("; ") : "none of the data areas"}.`);
  if (access.missing.length) lines.push(`- No permission for: ${access.missing.join("; ")}.`);
  lines.push(`- Changes you can propose: ${writeTools.length ? writeTools.join(", ") : "none"}.`);
  return lines.join("\n");
}

/** Does an answer tell the user that a permission is missing? */
export function saysPermissionMissing(text: string | null): boolean {
  return !!text && /berechtigung|permission/i.test(text);
}
