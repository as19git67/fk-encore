/**
 * The assistant's areas (documentation/plans/assistent-wegfindung.md,
 * stage 1): what the router chooses between, and what a choice brings.
 *
 * An area is data: the tools that belong to it, the rule block the model
 * reads only when the area is in play, the examples that show its roads, and
 * the words that point to it. The agent loop builds the system prompt from
 * the general rules plus the blocks of the areas the router picked, and
 * offers only their tools — the counterpart of Anthropic's routing, OpenAI's
 * handoff and VS Code's virtual tool groups, without a second agent.
 *
 * Every tool has exactly one home area (`tools`); an area may also borrow
 * tools of other areas it regularly needs (`borrows`), so a tax question
 * can list bookings without switching. `areas.test.ts` checks that every
 * tool of the catalog has a home and only one.
 */

import { BUSINESSES_AREA } from "./businesses";
import { DEPOT_AREA } from "./depot";
import { DOCUMENTS_AREA } from "./documents";
import { FINANCE_AREA } from "./finance";
import { METERS_AREA } from "./meters";
import { PHOTOS_AREA } from "./photos";
import { TAX_AREA } from "./tax";
import { TRIPS_AREA } from "./trips";
import { WRITING_AREA } from "./writing";

export type AreaId =
  | "finance"
  | "depot"
  | "documents"
  | "tax"
  | "photos"
  | "meters"
  | "businesses"
  | "trips"
  | "writing";

export interface Area {
  id: AreaId;
  /** One line for the router and for the "other areas" list in the prompt. */
  description: string;
  /** Tools whose home this area is. */
  tools: string[];
  /** Tools of other areas this one offers as well. */
  borrows?: string[];
  /** The rule block the model reads when the area is in play; empty when the general rules suffice. */
  rules: string[];
  /** Examples of chained calls, each a complete line. */
  examples: string[];
  /**
   * Alternatives of a regular expression (no anchors, no flags) that point
   * to the area, in German and English, as the user writes them. Matched
   * case-insensitively at a word start.
   */
  keywords: string;
}

export const AREAS: Area[] = [
  FINANCE_AREA,
  DEPOT_AREA,
  BUSINESSES_AREA,
  DOCUMENTS_AREA,
  TAX_AREA,
  PHOTOS_AREA,
  METERS_AREA,
  TRIPS_AREA,
  WRITING_AREA,
];

export const AREA_IDS: AreaId[] = AREAS.map((a) => a.id);

const BY_ID = new Map<AreaId, Area>(AREAS.map((a) => [a.id, a]));

export function areaById(id: string): Area | undefined {
  return BY_ID.get(id as AreaId);
}

export function isAreaId(value: unknown): value is AreaId {
  return typeof value === "string" && BY_ID.has(value as AreaId);
}

const HOME = new Map<string, AreaId>();
for (const area of AREAS) for (const name of area.tools) HOME.set(name, area.id);

/** The area a tool belongs to; undefined for a tool outside every area (describe_tools, switch_area). */
export function homeOf(tool: string): AreaId | undefined {
  return HOME.get(tool);
}

/** The tool names an area offers: its own and the borrowed ones. */
export function toolsOfArea(area: Area): string[] {
  return [...area.tools, ...(area.borrows ?? [])];
}

/** The areas of a set of tool names, in catalog order. */
export function areasOfTools(tools: Iterable<string>): AreaId[] {
  const hit = new Set<AreaId>();
  for (const name of tools) {
    const home = HOME.get(name);
    if (home) hit.add(home);
  }
  return AREA_IDS.filter((id) => hit.has(id));
}
