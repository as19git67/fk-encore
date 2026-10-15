/**
 * Which operations of the generated OpenAPI spec the assistant offers, and
 * how (documentation/plans/ki-assistent.md, "the catalog is generated, the
 * allow-list is written").
 *
 * Everything not listed here is never offered: deleting, sharing, FinTS sync
 * and admin endpoints stay out by omission. An entry names the operation by
 * its `operationId` as Encore writes it (`GET:photo.listPersons`), gives it a
 * tool name, its kind and the permissions the user needs to see it, and may
 * replace the spec's summary with a sentence written for the model.
 *
 * Endpoints whose results need trimming, a list route or a computation get a
 * hand-written tool in `tools/` instead and are not listed here.
 */

import type { ToolKind } from "./types";

export interface AllowlistEntry {
  operationId: string;
  name: string;
  kind: ToolKind;
  permissions: string[];
  /** One sentence for the model; falls back to the spec's summary. */
  summary?: string;
  /** Fields of each result row shown to the model; the rest are dropped. */
  columns?: string[];
}

export const TOOL_ALLOWLIST: AllowlistEntry[] = [
  {
    operationId: "GET:photo.listPersons",
    name: "list_persons",
    kind: "read",
    permissions: ["module.photos", "photos.view"],
    summary: "People recognised in the photos (id, name); pass ids to list_photos as person_ids.",
    columns: ["id", "name", "faceCount"],
  },
];
