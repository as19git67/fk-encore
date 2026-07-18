/**
 * Thin HTTP client for the llm-service /recap-title endpoint.
 *
 * Used by the recap builders to produce warm, human-sounding titles from
 * the structured recap context (kind, place, person, date range, …).
 *
 * Design goals:
 *  - Never throw on network/5xx; return `null` so the caller uses its
 *    deterministic fallback title. A rebuild run that can't reach the
 *    LLM must still succeed.
 *  - Short timeout (8s) — rebuilds can produce many recaps per user and
 *    we don't want a slow LLM to stall the whole pass.
 *  - No persistent side effects: caching the LLM result is the caller's
 *    responsibility (stored in `recap.seed.llm_title`).
 */

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const RECAP_TITLE_TIMEOUT_MS = parseInt(process.env.RECAP_TITLE_TIMEOUT_MS ?? "8000", 10);
const RECAP_TITLE_ENABLED = (process.env.RECAPS_LLM_TITLES ?? "1") !== "0";

export interface RecapTitleContext {
  kind: string;
  place_city?: string | null;
  place_country?: string | null;
  date_range?: string | null;
  years_ago?: number | null;
  person_name?: string | null;
  year?: number | null;
  month_label?: string | null;
  photo_count?: number | null;
  keywords?: string[];
  year_then?: number | null;
  year_now?: number | null;
}

export interface RecapTitleResult {
  title: string;
  subtitle: string | null;
}

function cleanContext(ctx: RecapTitleContext): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: ctx.kind, locale: "de" };
  if (ctx.place_city) out.place_city = ctx.place_city;
  if (ctx.place_country) out.place_country = ctx.place_country;
  if (ctx.date_range) out.date_range = ctx.date_range;
  if (typeof ctx.years_ago === "number") out.years_ago = ctx.years_ago;
  if (ctx.person_name) out.person_name = ctx.person_name;
  if (typeof ctx.year === "number") out.year = ctx.year;
  if (ctx.month_label) out.month_label = ctx.month_label;
  // photo_count intentionally omitted — the LLM tends to bake it into
  // the title/subtitle where it adds no value.
  if (ctx.keywords && ctx.keywords.length > 0) out.keywords = ctx.keywords.slice(0, 8);
  if (typeof ctx.year_then === "number") out.year_then = ctx.year_then;
  if (typeof ctx.year_now === "number") out.year_now = ctx.year_now;
  return out;
}

export async function generateRecapTitle(
  ctx: RecapTitleContext,
): Promise<RecapTitleResult | null> {
  if (!RECAP_TITLE_ENABLED) return null;

  const url = `${LLM_SERVICE_URL}/recap-title`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECAP_TITLE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanContext(ctx)),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: unknown; subtitle?: unknown };
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) return null;
    const subtitleRaw = typeof data.subtitle === "string" ? data.subtitle.trim() : "";
    return { title, subtitle: subtitleRaw || null };
  } catch {
    // Network failure, timeout, or malformed response — fall back silently.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
