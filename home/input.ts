/**
 * Input rules shared by the systems and the parts of the house handbook.
 */

import { APIError } from "encore.dev/api";

export const MAX_TEXT = 10_000;

export function requiredText(value: string | undefined | null, field: string, max = 200): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw APIError.invalidArgument(`${field} must not be empty`);
  if (trimmed.length > max) throw APIError.invalidArgument(`${field} is too long (max ${max})`);
  return trimmed;
}

export function optionalText(value: string | undefined | null, field: string, max = MAX_TEXT): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw APIError.invalidArgument(`${field} is too long (max ${max})`);
  return trimmed;
}

/** `%term%` for ILIKE, with the wildcards of the term itself escaped. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
