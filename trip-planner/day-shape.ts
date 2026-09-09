/**
 * The shape of a day: which blocks it has, and how long they are
 * (§4.1, §15.2).
 *
 * "Der Blocktyp ist ein **Etikett samt Standardbudget**, keine feste
 * Aufzählung — ein Tag hält eine geordnete Liste von Blöcken, nicht
 * vier Felder." The data model has been that from the start, and
 * `POST /plans` has always accepted a custom list. Two things were
 * missing:
 *
 *   - **It could not be changed afterwards.** A day with a lunch break
 *     nobody wanted stayed that way for the length of the trip.
 *   - **It did not survive.** A re-plan built the day from
 *     `DEFAULT_DAY` rather than from what the trip was created with, so
 *     a custom shape quietly reverted to the standard four the first
 *     time somebody changed the pace. That is the same class of bug as
 *     a pool entry losing its provenance: a decision somebody made,
 *     dropped by machinery that never knew about it.
 *
 * Replace-all rather than a patch per block: a day *is* the ordered
 * list, and "move the lunch break earlier" is a statement about the
 * list, not about one entry. The screen sends what the day should look
 * like, and the planner re-plans around it.
 */

import { APIError } from "encore.dev/api";
import { DEFAULT_DAY, type BlockTemplate } from "./blocks";

/** More than this is not a day, it is a timetable (§4.1). */
export const MAX_BLOCKS = 8;
/** Below this a block cannot hold anything worth planning. */
export const MIN_BLOCK_MINUTES = 15;
export const MAX_BLOCK_MINUTES = 600;

export interface BlockShapeInput {
  id?: string;
  label: string;
  kind?: string;
  baseBudgetMinutes: number;
}

/**
 * What the trip's day shape is, from what is stored on it.
 *
 * Null means "the default four" rather than a stored copy of them:
 * storing the default would freeze today's numbers into every trip
 * created before they were ever changed.
 */
export function dayShapeOf(constraints: Record<string, unknown>): readonly BlockTemplate[] {
  const stored = constraints.blocks;
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_DAY;
  const blocks = stored
    .map((entry) => toTemplate(entry))
    .filter((block): block is BlockTemplate => block !== null);
  return blocks.length > 0 ? blocks : DEFAULT_DAY;
}

/**
 * Validate a day somebody just drew, and answer it as templates.
 *
 * Three rules, and each is a thing that would otherwise fail much later
 * and much more quietly:
 *
 *   - **At least one block that holds spots.** A day of nothing but
 *     meal blocks is a day the planner cannot put anything in, and it
 *     would come back empty with no explanation (§10.3).
 *   - **Ids are unique**, because every stop, every move and every
 *     fixpoint addresses its block by id.
 *   - **Budgets are minutes, within reason.** A twelve-hour block is
 *     not a block; a five-minute one cannot hold a spot.
 */
export function validateDayShape(blocks: readonly BlockShapeInput[]): BlockTemplate[] {
  if (blocks.length === 0) {
    throw APIError.invalidArgument("ein Tag braucht mindestens einen Block");
  }
  if (blocks.length > MAX_BLOCKS) {
    throw APIError.invalidArgument(`mehr als ${MAX_BLOCKS} Blöcke sind kein Tag mehr`);
  }

  const seen = new Set<string>();
  const templates: BlockTemplate[] = [];
  for (const [position, block] of blocks.entries()) {
    const label = block.label.trim();
    if (!label) throw APIError.invalidArgument("jeder Block braucht einen Namen");
    if (label.length > 60) {
      throw APIError.invalidArgument("ein Blockname darf höchstens 60 Zeichen haben");
    }

    const kind = block.kind === "meal" ? "meal" : "spots";
    const minutes = block.baseBudgetMinutes;
    if (!Number.isInteger(minutes) || minutes < MIN_BLOCK_MINUTES || minutes > MAX_BLOCK_MINUTES) {
      throw APIError.invalidArgument(
        `„${label}“: die Dauer muss zwischen ${MIN_BLOCK_MINUTES} und ${MAX_BLOCK_MINUTES} `
        + "Minuten liegen",
      );
    }

    const id = (block.id ?? "").trim() || slug(label, position);
    if (seen.has(id)) {
      throw APIError.invalidArgument(`zwei Blöcke mit derselben Kennung: „${id}“`);
    }
    seen.add(id);

    templates.push({ id, label, kind, baseBudgetMinutes: minutes });
  }

  if (!templates.some((block) => block.kind === "spots")) {
    throw APIError.invalidArgument(
      "mindestens ein Block muss Spots aufnehmen — sonst bleibt der Tag leer",
    );
  }
  return templates;
}

function toTemplate(entry: unknown): BlockTemplate | null {
  if (typeof entry !== "object" || entry === null) return null;
  const row = entry as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  const label = typeof row.label === "string" ? row.label : null;
  const minutes = typeof row.baseBudgetMinutes === "number" ? row.baseBudgetMinutes : null;
  if (!id || !label || minutes === null) return null;
  return {
    id,
    label,
    kind: row.kind === "meal" ? "meal" : "spots",
    baseBudgetMinutes: minutes,
  };
}

/**
 * An id from the label: readable in a URL and in a stop's row, and
 * stable enough that renaming "Vormittag" to "Morgen" does not silently
 * detach everything that pointed at it — the caller sends the id it
 * already has, and only a new block needs one made up.
 */
function slug(label: string, position: number): string {
  const base = label
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }[c] ?? c))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `block-${position + 1}`;
}
