/**
 * How a result row reads on a client that knows nothing about its kind
 * (documentation/plans/assistent-ios.md, stage 1).
 *
 * The web app has a renderer per block kind (`AssistantBlock.vue`), some 800
 * lines of knowledge about which field is the title of a booking, a security
 * or a parcel. A second client would have to carry the same knowledge and the
 * two would drift apart. So the server says it once: every row gets a
 * `display` with a title, a subtitle, the figure that stands at the right
 * edge (`value`, already formatted), its sign (`tone`) and the web path that
 * opens the object (`route`). A client that has its own screen for a kind
 * ignores `display`; for every other kind the one generic row is enough.
 *
 * Formatting here is German, like the answers: the clients show strings, they
 * do not parse them. Nothing of this reaches the model — blocks are for the
 * client only (`agent.ts`), so adding to them costs no tokens.
 */

import type { ResultBlock } from "./types";

type Row = Record<string, unknown>;

/** How the figure reads: money in, money out, or neither. */
export type DisplayTone = "in" | "out" | "neutral";

export interface RowDisplay {
  title: string;
  subtitle?: string;
  /** The figure at the right edge, formatted. */
  value?: string;
  tone?: DisplayTone;
  /** A date shown before the title, formatted `TT.MM.JJJJ`. */
  date?: string;
  /** The web path that opens the object, without the `/app` prefix; absent when nothing opens. */
  route?: string;
  /** For photos and documents: the id the client loads a thumbnail for. */
  thumbnail?: { kind: "photo"; id: number; filename: string } | { kind: "document"; id: number };
}

/** The title of a block of this kind, as the web app shows it. */
export const BLOCK_TITLES: Record<string, string> = {
  accounts: "Konten",
  transactions: "Buchungen",
  analysis: "Auswertung",
  debits: "Erwartete Zahlungen",
  categories: "Kategorien",
  documents: "Dokumente",
  document: "Dokument",
  photos: "Fotos",
  recaps: "Rückblicke",
  albums: "Alben",
  meters: "Zähler",
  readings: "Zählerstände",
  consumption: "Verbrauch",
  trip_plans: "Reisepläne",
  positions: "Wertpapiere",
  depot_transactions: "Depotumsätze",
  quotes: "Kurse",
  news: "Nachrichten",
  comments: "Kommentare",
  activity: "Neuigkeiten",
  businesses: "Betriebe",
  business_assets: "Anlagegüter und Flächen",
  euer: "Einnahmen-Überschuss-Rechnung",
  proposal: "Vorschlag",
  table: "Ergebnis",
};

const DEPOT_KINDS: Record<string, string> = {
  buy: "Kauf", sell: "Verkauf", dividend: "Dividende", in: "Einlieferung", out: "Auslieferung",
  split: "Split", corp_action: "Kapitalmaßnahme", tax: "Steuer",
};

const ACTIVITY_KINDS: Record<string, string> = {
  photo_commented: "Kommentar", photo_favorited: "Favorit", photo_added: "Fotos hinzugefügt",
  album_shared: "Album geteilt", album_left: "Album verlassen",
};

const BUSINESS_KINDS: Record<string, string> = {
  landwirtschaft: "Landwirtschaft", photovoltaik: "Photovoltaik", gewerbe: "Gewerbe", vermietung: "Vermietung",
};

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function has(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

/** `2026-03-04T…` → `04.03.2026`. */
export function formatDate(v: unknown): string {
  const s = str(v);
  return s.length >= 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : "";
}

const EUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const PLAIN = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An amount in euro, or in another currency with its code after the number. */
export function formatMoney(v: unknown, currency?: unknown): string {
  const n = num(v);
  if (n === null) return "";
  const c = str(currency);
  // ICU puts a narrow or a plain no-break space before the sign depending on
  // its CLDR version; one no-break space, always, so a client can rely on it.
  return c && c !== "EUR" ? `${PLAIN.format(n)}\u00a0${c}` : EUR.format(n).replace(/[\u202f\u00a0 ]€/, "\u00a0€");
}

function tone(v: unknown): DisplayTone {
  const n = num(v) ?? 0;
  return n < 0 ? "out" : n > 0 ? "in" : "neutral";
}

function join(parts: unknown[], sep = " · "): string {
  return parts.map(str).filter(Boolean).join(sep);
}

function route(r: Row): string | undefined {
  const s = str(r.route);
  return s || undefined;
}

function albumSubtitle(r: Row): string {
  const parts: string[] = [str(r.event_name)];
  if (has(r.photo_count)) parts.push(`${str(r.photo_count)} Fotos`);
  if (r.shared_with) parts.push(`geteilt mit ${str(r.shared_with)}`);
  else if (r.public_link === true) parts.push("öffentlicher Link");
  else if (r.shared === true) parts.push("freigegeben");
  return join(parts);
}

/** The scalar columns of a row no kind-specific rule knows, at most four. */
function genericColumns(first: Row): string[] {
  return Object.keys(first)
    .filter((k) => k !== "route" && k !== "display" && ["string", "number", "boolean"].includes(typeof first[k]))
    .slice(0, 4);
}

/** The display of one row of the given kind. */
export function displayOf(kind: string, r: Row, columns: string[] = genericColumns(r)): RowDisplay {
  switch (kind) {
    case "accounts":
      return {
        title: str(r.label),
        subtitle: join([r.section, r.type]),
        value: has(r.balance) ? formatMoney(r.balance) : "kein Saldo",
        tone: has(r.balance) ? tone(r.balance) : "neutral",
        route: route(r),
      };
    case "transactions":
      return {
        title: str(r.counterparty) || "Ohne Gegenpartei",
        subtitle: str(r.purpose) || undefined,
        date: formatDate(r.booking_date) || undefined,
        value: formatMoney(r.amount),
        tone: tone(r.amount),
        route: has(r.id) ? `/finanzen/umsaetze/${str(r.id)}` : undefined,
      };
    case "debits":
      return {
        title: str(r.counterparty) || "Unbekannter Empfänger",
        subtitle: join([r.overdue ? "überfällig" : "", r.account_label]),
        date: formatDate(r.expected_date) || undefined,
        value: formatMoney(r.typical_amount),
        tone: tone(r.typical_amount),
      };
    case "documents":
    case "document": {
      const id = num(r.id);
      return {
        title: str(r.title),
        subtitle: join([formatDate(r.doc_date), r.from]),
        route: id !== null ? `/dokumente/${id}` : undefined,
        thumbnail: id !== null ? { kind: "document", id } : undefined,
      };
    }
    case "photos": {
      const id = num(r.id);
      return {
        title: formatDate(r.taken_at) || str(r.filename) || (id !== null ? `Foto ${id}` : "Foto"),
        route: id !== null ? `/fotos/galerie?photoId=${id}` : undefined,
        thumbnail: id !== null && r.filename ? { kind: "photo", id, filename: str(r.filename) } : undefined,
      };
    }
    case "recaps":
      return {
        title: str(r.title ?? r.name),
        subtitle: join([join([formatDate(r.period_start), formatDate(r.period_end)], " – "), has(r.photo_count) ? `${str(r.photo_count)} Fotos` : ""]),
        route: route(r),
      };
    case "albums":
      return { title: str(r.title ?? r.name), subtitle: albumSubtitle(r), route: route(r) };
    case "meters":
      return {
        title: str(r.title ?? r.name),
        subtitle: has(r.last_value) ? `${str(r.last_value)} ${str(r.unit)} am ${formatDate(r.last_read)}` : "Noch kein Stand",
        route: route(r),
      };
    case "businesses":
      return {
        title: str(r.name),
        subtitle: join([BUSINESS_KINDS[str(r.kind)] ?? str(r.kind), str(r.tax_section).toUpperCase(), has(r.asset_count) ? `${str(r.asset_count)} Anlagegüter` : "", has(r.parcel_count) ? `${str(r.parcel_count)} Flächen` : ""]),
        route: route(r),
      };
    case "business_assets":
      if (r.kind === "parcel") {
        return {
          title: str(r.name),
          subtitle: join([r.usage, has(r.area_m2) ? `${str(r.area_m2)} m²` : "", r.lessee ? `Pächter ${str(r.lessee)}` : ""]),
          value: has(r.annual_rent) ? `${formatMoney(r.annual_rent)}/Jahr` : undefined,
          route: route(r),
        };
      }
      return {
        title: str(r.name),
        subtitle: join([r.kind, has(r.acquisition_cost) ? `AK ${formatMoney(r.acquisition_cost)}` : "", has(r.afa_rate_pct) ? `${Number(r.afa_rate_pct)} %` : ""]),
        value: join([has(r.afa) ? `AfA ${formatMoney(r.afa)}` : "", has(r.book_value) ? `BW ${formatMoney(r.book_value)}` : ""]) || undefined,
        route: route(r),
      };
    case "euer":
      return {
        title: join([r.form_line, r.name]),
        subtitle: join([
          r.kind === "income" ? "Einnahme" : r.kind === "expense" ? "Ausgabe" : "AfA",
          r.count ? `${str(r.count)} ${r.kind === "afa" ? "Anlagegüter" : "Buchungen"}` : "",
        ]),
        value: formatMoney(r.sum) || undefined,
        tone: r.kind === "expense" ? "out" : r.kind === "income" ? "in" : "neutral",
        route: route(r),
      };
    case "positions": {
      const gain = has(r.unrealized_gain)
        ? `${formatMoney(r.unrealized_gain, r.currency)}${r.unrealized_gain_pct ? ` (${str(r.unrealized_gain_pct)} %)` : ""}`
        : "";
      return {
        title: str(r.name),
        subtitle: join([r.depots, r.isin, r.amount ? `${str(r.amount)} Stück` : "", r.open === false ? "verkauft" : ""]),
        value: join([formatMoney(r.value, r.currency), gain]) || undefined,
        tone: has(r.unrealized_gain) ? tone(r.unrealized_gain) : "neutral",
        route: route(r),
      };
    }
    case "depot_transactions":
      return {
        title: join([DEPOT_KINDS[str(r.kind)] ?? str(r.kind), r.name]),
        subtitle: join([r.account_label, r.amount ? `${str(r.amount)} Stück` : ""]),
        date: formatDate(r.executed_at) || undefined,
        value: formatMoney(r.net_amount, r.currency) || undefined,
        tone: tone(r.net_amount),
        route: route(r),
      };
    case "quotes": {
      const change = num(r.change_percent);
      return {
        title: str(r.name),
        subtitle: join([
          r.status === "ok" ? formatMoney(r.value, r.currency) : r.status === "unresolved" ? "keine Kursquelle" : "noch kein Kurs",
          (num(r.news_unread) ?? 0) > 0 ? `${str(r.news_unread)} neue Nachrichten` : "",
        ]),
        value: join([has(r.price) ? formatMoney(r.price, r.currency) : "–", change !== null ? `${change > 0 ? "+" : ""}${str(r.change_percent)} %` : ""]),
        tone: change !== null ? tone(change) : "neutral",
        route: route(r),
      };
    }
    case "news":
      return {
        title: str(r.title),
        subtitle: str(r.source) || undefined,
        date: formatDate(r.at) || undefined,
        route: str(r.url) || undefined,
      };
    case "comments":
      return { title: str(r.author), subtitle: str(r.body) || undefined, date: formatDate(r.at) || undefined, route: route(r) };
    case "activity":
      return {
        title: join([r.actor, ACTIVITY_KINDS[str(r.kind)] ?? str(r.kind), r.album]),
        subtitle: str(r.what) || undefined,
        date: formatDate(r.at) || undefined,
        route: route(r),
      };
    case "trip_plans":
      return {
        title: str(r.title) || "Reise",
        subtitle: has(r.day_count) ? `${str(r.day_count)} Tage` : undefined,
        date: formatDate(r.start_date) || undefined,
        route: route(r),
      };
    case "readings":
      return { title: formatDate(r.taken_at) || str(r.taken_at), value: str(r.value) || undefined };
    case "consumption":
      return { title: str(r.period), value: str(r.consumption) || undefined };
    case "analysis": {
      // One row: the total and its groups; the client shows the groups itself
      // when it knows the kind, else this line.
      return {
        title: has(r.count) ? `aus ${str(r.count)} Buchungen` : "Summe",
        value: formatMoney(r.sum) || undefined,
        tone: tone(r.sum),
      };
    }
    case "proposal":
      return {
        title: str(r.summary),
        subtitle: str(r.result_summary) || (str(r.status) === "pending" ? "Wartet auf Bestätigung" : str(r.status)) || undefined,
        route: route(r),
      };
    default: {
      // The second scalar column names a row better than its id.
      const key = columns[1] ?? columns[0];
      return {
        title: key ? str(r[key]) : "",
        subtitle: columns.slice(2).map((c) => str(r[c])).filter(Boolean).join(" · ") || undefined,
        route: route(r),
      };
    }
  }
}

function clean(d: RowDisplay): RowDisplay {
  const out: RowDisplay = { title: d.title };
  if (d.subtitle) out.subtitle = d.subtitle;
  if (d.value) out.value = d.value;
  if (d.tone && d.tone !== "neutral") out.tone = d.tone;
  if (d.date) out.date = d.date;
  if (d.route) out.route = d.route;
  if (d.thumbnail) out.thumbnail = d.thumbnail;
  return out;
}

/** The block with a `display` on every row and a `title` of its own. */
export function presentBlock(block: ResultBlock): ResultBlock {
  const columns = genericColumns(block.rows[0] ?? {});
  return {
    ...block,
    title: BLOCK_TITLES[block.kind] ?? "Ergebnis",
    rows: block.rows.map((r) => ({ ...r, display: clean(displayOf(block.kind, r, columns)) })),
  };
}

export function presentBlocks(blocks: ResultBlock[]): ResultBlock[] {
  return blocks.map(presentBlock);
}
