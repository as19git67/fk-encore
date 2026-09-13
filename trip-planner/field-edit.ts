/**
 * What a partial edit means (§9.2, §20).
 *
 * Every screen that edits a saved place sends the fields it has on it,
 * and the fields it does not send must survive. Getting that wrong is
 * quiet and expensive: a sheet that edits only the note would wipe the
 * link every time somebody saved, and nobody notices until the link is
 * needed.
 *
 * So three states, not two:
 *
 *   - **omitted** (`undefined`) — leave what is there;
 *   - **cleared** (`null`, or a string of only spaces) — take it away;
 *   - **given** — trim it and keep it.
 *
 * Written once here because two endpoints need exactly this rule — the
 * note on a planned spot (`spot-notes.ts`) and the entry in the idea
 * collection (`idea-edit.ts`) — and two copies of a rule this easy to
 * get subtly different is how they end up disagreeing about what an
 * empty field means.
 */

import { APIError } from "encore.dev/api";

/** The new value of one text field, per the rule above. */
export function resolveText(
  incoming: string | null | undefined,
  current: string | null,
  max: number,
  field: string,
): string | null {
  if (incoming === undefined) return current;
  if (incoming === null) return null;
  const trimmed = incoming.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw APIError.invalidArgument(`${field} may be at most ${max} characters`);
  }
  return trimmed;
}

/**
 * A link the app can actually open.
 *
 * Only http and https: a `javascript:` or `data:` string in a field
 * that renders as a tappable link is not a link, and refusing it here
 * is cheaper than remembering to refuse it in every client.
 */
export function validateUrl(url: string | null): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw APIError.invalidArgument("url must be a full web address, e.g. https://beispiel.test");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw APIError.invalidArgument("url must be an http or https address");
  }
  return parsed.toString();
}

/** How long people stay, in minutes — the same bounds everywhere. */
export const MIN_DWELL_MINUTES = 5;
export const MAX_DWELL_MINUTES = 480;

export function resolveDwellMinutes(
  incoming: number | null | undefined,
  current: number | null,
): number | null {
  if (incoming === undefined) return current;
  if (incoming === null) return null;
  if (!Number.isInteger(incoming)
      || incoming < MIN_DWELL_MINUTES || incoming > MAX_DWELL_MINUTES) {
    throw APIError.invalidArgument(
      `dwellMinutes must be an integer between ${MIN_DWELL_MINUTES} and ${MAX_DWELL_MINUTES}`,
    );
  }
  return incoming;
}

/**
 * A date field on an edit: `YYYY-MM-DD`, cleared, or left alone.
 *
 * Same three states as the text fields. An exhibition that has been
 * extended needs its end date changed, and one that turned out to be
 * permanent needs it gone — and neither may happen by accident when a
 * screen saves the note.
 */
export function resolveDay(
  incoming: string | null | undefined,
  current: string | null,
  field: string,
): string | null {
  if (incoming === undefined) return current;
  if (incoming === null) return null;
  const trimmed = incoming.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw APIError.invalidArgument(`${field} must be YYYY-MM-DD, got '${incoming}'`);
  }
  return trimmed;
}
