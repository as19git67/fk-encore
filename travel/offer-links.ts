/**
 * Links to an offer that still work when opened later.
 *
 * SerpApi hands over the provider links as Google shows them: most are
 * click redirects (`google.com/aclk`, `google.com/travel/clk`,
 * `googleadservices.com`) bound to the Google session that rendered the
 * page. Opened a day later from the watch page or a mail they end on a
 * Google error or an empty ad page. So a redirect is replaced:
 *
 * 1. by the target it carries in a parameter (`adurl`, `pcurl`, `url`, …),
 * 2. for the hotel's own offer by the hotel website from the detail answer,
 * 3. for a known portal by its search with hotel name, dates and party,
 * 4. otherwise by the hotel's Google Hotels page (from the property token),
 *    which lists every provider with a fresh link.
 *
 * A link that does not point at Google stays as it is. Plain functions
 * without I/O.
 */

export interface LinkContext {
  hotelName: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  childrenAges: number[];
  /** Rooms the offer books (double rooms of a split party). */
  rooms: number;
  propertyToken: string | null;
  /** The hotel's own website, from the detail answer. */
  hotelSite?: string | null;
}

const GOOGLE_HOST = /(^|\.)(google\.(com|[a-z]{2}|com?\.[a-z]{2})|googleadservices\.com|doubleclick\.net|googlesyndication\.com)$/i;
const TARGET_PARAMS = ["adurl", "pcurl", "url", "q", "dest", "u"];

function parse(link: string): URL | null {
  try {
    const u = new URL(link);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** True for a Google host — redirects, ad clicks and Google's own pages. */
export function isGoogleLink(link: string): boolean {
  const u = parse(link);
  return u !== null && GOOGLE_HOST.test(u.hostname);
}

/** The non-Google target a Google redirect carries in a parameter, if any. */
export function unwrapRedirect(link: string): string | null {
  const u = parse(link);
  if (!u || !GOOGLE_HOST.test(u.hostname)) return null;
  for (const name of TARGET_PARAMS) {
    const value = u.searchParams.get(name);
    if (!value) continue;
    const target = parse(value);
    if (target && !GOOGLE_HOST.test(target.hostname)) return target.toString();
  }
  return null;
}

/** The provider's name folded for matching ("Booking.com" → "bookingcom"). */
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Search on a known portal for the hotel and the stay, or null for an unknown provider. */
export function portalSearchLink(source: string, ctx: LinkContext): string | null {
  const name = fold(source);
  const kids = ctx.childrenAges;
  if (name.startsWith("booking")) {
    const u = new URL("https://www.booking.com/searchresults.de.html");
    u.searchParams.set("ss", ctx.hotelName);
    u.searchParams.set("checkin", ctx.checkIn);
    u.searchParams.set("checkout", ctx.checkOut);
    u.searchParams.set("group_adults", String(ctx.adults));
    u.searchParams.set("no_rooms", String(Math.max(1, ctx.rooms)));
    u.searchParams.set("group_children", String(kids.length));
    for (const age of kids) u.searchParams.append("age", String(age));
    return u.toString();
  }
  const expediaHost = name.startsWith("expedia")
    ? "https://www.expedia.de"
    : name.startsWith("hotelscom") || name === "hotels"
      ? "https://de.hotels.com"
      : null;
  if (expediaHost) {
    const u = new URL(`${expediaHost}/Hotel-Search`);
    u.searchParams.set("destination", ctx.hotelName);
    u.searchParams.set("startDate", ctx.checkIn);
    u.searchParams.set("endDate", ctx.checkOut);
    u.searchParams.set("adults", String(ctx.adults));
    if (kids.length) u.searchParams.set("children", kids.map((a) => `1_${a}`).join(","));
    return u.toString();
  }
  return null;
}

/** The hotel's page on Google Hotels: all providers, each with a fresh link. */
export function googleHotelsLink(ctx: LinkContext): string {
  if (ctx.propertyToken) {
    const u = new URL(`https://www.google.com/travel/hotels/entity/${encodeURIComponent(ctx.propertyToken)}/prices`);
    u.searchParams.set("hl", "de");
    u.searchParams.set("gl", "de");
    return u.toString();
  }
  const u = new URL("https://www.google.com/travel/search");
  u.searchParams.set("q", ctx.hotelName);
  u.searchParams.set("hl", "de");
  u.searchParams.set("gl", "de");
  return u.toString();
}

/**
 * A link for the offer that works later. `official` marks the hotel's own
 * offer (SerpApi's `official: true`).
 */
export function durableLink(
  link: string | null,
  source: string,
  ctx: LinkContext,
  official = false,
): string | null {
  if (link && !isGoogleLink(link)) return link;
  if (link) {
    const target = unwrapRedirect(link);
    if (target) return target;
  }
  if (official && ctx.hotelSite && !isGoogleLink(ctx.hotelSite)) return ctx.hotelSite;
  return portalSearchLink(source, ctx) ?? googleHotelsLink(ctx);
}
