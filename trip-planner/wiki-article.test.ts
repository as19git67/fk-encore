/**
 * The article behind a spot (§25, stage C): German where German
 * exists, otherwise the original first and the translation when it is
 * done; kept once it is; pictures when Commons answers and an article
 * when it does not. Every title, file and sentence is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripWikiArticles, users } from "../db/schema";
import type { CommonsClient, CommonsPhoto } from "./commons-client";
import {
  buildTranslationPrompt,
  clearArticleWork,
  clip,
  keepLanguagesOf,
  MAX_ARTICLE_PHOTOS,
  spotArticle,
  splitForTranslation,
  TRANSLATION_CHUNK_CHARS,
} from "./wiki-article";
import type { ArticleRef, WikipediaArticle, WikipediaClient } from "./wikipedia-client";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

class FakeWikipedia implements WikipediaClient {
  german = new Map<string, string>();
  articles = new Map<string, WikipediaArticle>();
  calls: string[] = [];

  async germanTitle(ref: ArticleRef): Promise<string | null> {
    this.calls.push(`de?${ref.lang}:${ref.title}`);
    return this.german.get(`${ref.lang}:${ref.title}`) ?? null;
  }

  async article(ref: ArticleRef): Promise<WikipediaArticle | null> {
    this.calls.push(`${ref.lang}:${ref.title}`);
    return this.articles.get(`${ref.lang}:${ref.title}`) ?? null;
  }

  revisionFails = false;

  async revision(ref: ArticleRef): Promise<number | null> {
    this.calls.push(`rev?${ref.lang}:${ref.title}`);
    if (this.revisionFails) throw new Error("wikipedia down");
    return this.articles.get(`${ref.lang}:${ref.title}`)?.revision ?? null;
  }
}

class FakeCommons implements CommonsClient {
  fail = false;
  async imagesOf(): Promise<Map<string, string>> { return new Map(); }
  async files(titles: readonly string[]): Promise<CommonsPhoto[]> {
    if (this.fail) throw new Error("commons down");
    // Commons answers in its own order; the strip must not.
    return [...titles].reverse().map((title) => ({
      title,
      thumbUrl: `https://upload.example.test/${encodeURIComponent(title)}`,
      thumbWidth: 640, thumbHeight: 480,
      pageUrl: `https://commons.example.test/wiki/${encodeURIComponent(title)}`,
      author: "Beispiel Fotograf", license: "CC BY-SA 4.0",
    }));
  }
  async nearby(): Promise<CommonsPhoto[]> { return []; }
}

function article(lang: string, title: string, lead: string): WikipediaArticle {
  return {
    lang, title,
    pageUrl: `https://${lang}.wikipedia.org/wiki/${title.replace(/ /g, "_")}`,
    revision: 100,
    description: lang === "de" ? "Kirche in Musterstadt" : "chiesa di Esempio",
    sections: [
      { heading: null, level: 1, text: lead },
      { heading: lang === "de" ? "Geschichte" : "Storia", level: 2, text: lang === "de" ? "Der Bau begann 1180." : "La costruzione iniziò nel 1180." },
    ],
    mainImage: "File:Beispielkirche Westfassade.jpg",
    images: ["File:Beispielkirche Westfassade.jpg", "File:Innenraum.jpg"],
  };
}

let wiki: FakeWikipedia;
let commons: FakeCommons;
const translated: string[] = [];
const translate = async (text: string): Promise<string> => {
  translated.push(text);
  return `[de] ${text}`;
};

beforeEach(async () => {
  await db.delete(tripWikiArticles);
  clearArticleWork();
  translated.length = 0;
  const [user] = await db
    .insert(users)
    .values({ email: `wiki-${Date.now()}@test.invalid`, name: "Reader", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  wiki = new FakeWikipedia();
  commons = new FakeCommons();
  wiki.articles.set("de:Beispielkirche", article("de", "Beispielkirche", "Die Beispielkirche ist eine Kirche."));
  wiki.articles.set("it:Chiesa di Esempio", article("it", "Chiesa di Esempio", "La Chiesa di Esempio è una chiesa."));
});

describe("the article behind a spot", () => {
  it("shows a German article as it is, with its pictures in the article's order", async () => {
    const res = await spotArticle({ url: "https://de.wikipedia.org/wiki/Beispielkirche" }, { wiki, commons, translate });
    expect(res).toMatchObject({
      title: "Beispielkirche", language: "de", sourceLanguage: "de", translation: "none",
      attribution: "Wikipedia · CC BY-SA 4.0",
    });
    expect(res.sections.map((s) => s.heading)).toEqual([null, "Geschichte"]);
    expect(res.photos.map((p) => p.pageUrl)).toEqual([
      "https://commons.example.test/wiki/File%3ABeispielkirche%20Westfassade.jpg",
      "https://commons.example.test/wiki/File%3AInnenraum.jpg",
    ]);
    expect(translated).toEqual([]);
    // No language-link lookup for an article that is German already.
    expect(wiki.calls).toEqual(["de:Beispielkirche"]);
  });

  it("prefers the German article Wikipedia links from a foreign one", async () => {
    wiki.german.set("it:Chiesa di Esempio", "Beispielkirche");
    const res = await spotArticle({ url: "https://it.wikipedia.org/wiki/Chiesa_di_Esempio" }, { wiki, commons, translate });
    expect(res).toMatchObject({ title: "Beispielkirche", language: "de", translation: "none" });
    expect(res.sourceUrl).toBe("https://de.wikipedia.org/wiki/Beispielkirche");
    expect(translated).toEqual([]);
  });

  it("answers with the original first and the translation once it is done", async () => {
    const url = "https://it.wikipedia.org/wiki/Chiesa_di_Esempio";
    const first = await spotArticle({ url }, { wiki, commons, translate });
    expect(first).toMatchObject({ language: "it", sourceLanguage: "it", translation: "pending" });
    expect(first.sections[0].text).toBe("La Chiesa di Esempio è una chiesa.");

    // Asked again while the work runs: the same answer, no second job.
    const again = await spotArticle({ url }, { wiki, commons, translate });
    expect(again.translation).toBe("pending");

    const done = await spotArticle({ url }, { wiki, commons, translate, awaitTranslation: true });
    // The first call's job finished in between; whichever answered,
    // the result is German and kept.
    expect(done).toMatchObject({ language: "de", sourceLanguage: "it", translation: "done" });
    expect(done.sections.map((s) => s.heading)).toEqual([null, "[de] Storia"]);
    expect(done.sections[0].text).toBe("[de] La Chiesa di Esempio è una chiesa.");
    expect(done.description).toBe("[de] chiesa di Esempio");
    // The text as written stays with it, for the reader who wants it.
    expect(done.original).toMatchObject({ language: "it", description: "chiesa di Esempio" });
    expect(done.original?.sections[0].text).toBe("La Chiesa di Esempio è una chiesa.");

    const cached = await spotArticle({ url }, { wiki, commons, translate });
    expect(cached.translation).toBe("done");
    // Wikipedia was asked once for the article, not once per reader.
    expect(wiki.calls.filter((c) => c === "it:Chiesa di Esempio")).toHaveLength(1);
  });

  it("keeps the original and says so when the model fails", async () => {
    const failing = async (): Promise<string> => { throw new Error("llm down"); };
    const res = await spotArticle({ url: "https://it.wikipedia.org/wiki/Chiesa_di_Esempio" },
                                  { wiki, commons, translate: failing, awaitTranslation: true });
    expect(res).toMatchObject({ language: "it", translation: "failed" });
    expect(res.sections[0].text).toBe("La Chiesa di Esempio è una chiesa.");
  });

  it("leaves a language the reader understands as it is, and translates it for the next reader", async () => {
    const url = "https://it.wikipedia.org/wiki/Chiesa_di_Esempio";
    const kept = await spotArticle({ url, keepLanguages: "en, it" }, { wiki, commons, translate });
    expect(kept).toMatchObject({ language: "it", translation: "skipped" });
    expect(kept.original).toBeUndefined();
    expect(translated).toEqual([]);
    // Again with the same setting: the cached answer, no work.
    const again = await spotArticle({ url, keepLanguages: "it" }, { wiki, commons, translate });
    expect(again.translation).toBe("skipped");
    expect(wiki.calls.filter((c) => c === "it:Chiesa di Esempio")).toHaveLength(1);
    // A reader without Italian gets the translation, from the cached text.
    const done = await spotArticle({ url }, { wiki, commons, translate, awaitTranslation: true });
    expect(done).toMatchObject({ language: "de", translation: "done" });
    expect(wiki.calls.filter((c) => c === "it:Chiesa di Esempio")).toHaveLength(1);
    // German is never "kept": there is nothing to translate.
    const german = await spotArticle({ url: "https://de.wikipedia.org/wiki/Beispielkirche", keepLanguages: "de" }, { wiki, commons, translate });
    expect(german.translation).toBe("none");
  });

  it("is an article without pictures when Commons is down", async () => {
    commons.fail = true;
    const res = await spotArticle({ url: "https://de.wikipedia.org/wiki/Beispielkirche" }, { wiki, commons, translate });
    expect(res.photos).toEqual([]);
    expect(res.sections).toHaveLength(2);
  });

  it("refuses what is not an article and says when there is none", async () => {
    await expect(spotArticle({ url: "https://example.test/x" }, { wiki, commons, translate }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(spotArticle({ url: "https://de.wikipedia.org/wiki/Gibt_es_nicht" }, { wiki, commons, translate }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("asks once a day whether the page changed, and fetches it again only then", async () => {
    const url = "https://de.wikipedia.org/wiki/Beispielkirche";
    let now = Date.UTC(2026, 9, 4, 8);
    const clock = () => now;
    const first = await spotArticle({ url }, { wiki, commons, translate, now: clock });
    expect(first.revision).toBe(100);
    expect(first.fetchedAt).toBe(new Date(now).toISOString());

    // The same morning: no question to Wikipedia at all.
    now += 2 * 60 * 60 * 1000;
    await spotArticle({ url }, { wiki, commons, translate, now: clock });
    expect(wiki.calls.filter((c) => c.startsWith("rev?"))).toHaveLength(0);

    // Next day, unchanged: one cheap question, no fetch, and not asked
    // again until tomorrow.
    now += 24 * 60 * 60 * 1000;
    const checked = await spotArticle({ url }, { wiki, commons, translate, now: clock });
    expect(checked.checkedAt).toBe(new Date(now).toISOString());
    expect(checked.fetchedAt).toBe(first.fetchedAt);
    now += 60 * 60 * 1000;
    await spotArticle({ url }, { wiki, commons, translate, now: clock });
    expect(wiki.calls.filter((c) => c.startsWith("rev?"))).toHaveLength(1);
    expect(wiki.calls.filter((c) => c === "de:Beispielkirche")).toHaveLength(1);

    // Edited on Wikipedia: the reader still gets the kept text now,
    // and the new one is there for the next opening.
    now += 24 * 60 * 60 * 1000;
    wiki.articles.set("de:Beispielkirche", { ...article("de", "Beispielkirche", "Die Beispielkirche ist eine Basilika."), revision: 101 });
    const stale = await spotArticle({ url }, { wiki, commons, translate, now: clock, awaitTranslation: true });
    expect(stale.sections[0].text).toBe("Die Beispielkirche ist eine Basilika.");
    expect(stale.revision).toBe(101);
    expect(stale.fetchedAt).toBe(new Date(now).toISOString());
    const next = await spotArticle({ url }, { wiki, commons, translate, now: clock });
    expect(next.sections[0].text).toBe("Die Beispielkirche ist eine Basilika.");
  });

  it("translates a changed foreign article anew, and keeps the old one meanwhile", async () => {
    const url = "https://it.wikipedia.org/wiki/Chiesa_di_Esempio";
    let now = Date.UTC(2026, 9, 4, 8);
    const clock = () => now;
    const done = await spotArticle({ url }, { wiki, commons, translate, now: clock, awaitTranslation: true });
    expect(done.translation).toBe("done");

    now += 2 * 24 * 60 * 60 * 1000;
    wiki.articles.set("it:Chiesa di Esempio", { ...article("it", "Chiesa di Esempio", "La Chiesa di Esempio è una basilica."), revision: 7 });
    const meanwhile = await spotArticle({ url }, { wiki, commons, translate, now: clock });
    // The reader who opened it gets the finished translation, not a wait.
    expect(meanwhile.translation).toBe("done");
    expect(meanwhile.sections[0].text).toBe("[de] La Chiesa di Esempio è una chiesa.");
    const fresh = await spotArticle({ url }, { wiki, commons, translate, now: clock, awaitTranslation: true });
    expect(fresh.translation).toBe("done");
    expect(fresh.sections[0].text).toBe("[de] La Chiesa di Esempio è una basilica.");
    expect(fresh.original?.sections[0].text).toBe("La Chiesa di Esempio è una basilica.");
  });

  it("keeps the article when the revision check fails", async () => {
    const url = "https://de.wikipedia.org/wiki/Beispielkirche";
    let now = Date.UTC(2026, 9, 4, 8);
    const clock = () => now;
    await spotArticle({ url }, { wiki, commons, translate, now: clock });
    now += 2 * 24 * 60 * 60 * 1000;
    wiki.revisionFails = true;
    const kept = await spotArticle({ url }, { wiki, commons, translate, now: clock });
    expect(kept.sections[0].text).toBe("Die Beispielkirche ist eine Kirche.");
    expect(kept.checkedAt).toBeUndefined();
  });

  it("forgets an article after a month", async () => {
    const url = "https://de.wikipedia.org/wiki/Beispielkirche";
    let now = Date.UTC(2026, 9, 4);
    await spotArticle({ url }, { wiki, commons, translate, now: () => now });
    now += 31 * 24 * 60 * 60 * 1000;
    await spotArticle({ url }, { wiki, commons, translate, now: () => now });
    expect(wiki.calls.filter((c) => c === "de:Beispielkirche")).toHaveLength(2);
  });
});

describe("the pieces", () => {
  it("clips at a section boundary and always keeps the lead", () => {
    const sections = [
      { heading: null, level: 1, text: "x".repeat(100) },
      { heading: "A", level: 2, text: "y".repeat(100) },
      { heading: "B", level: 2, text: "z".repeat(100) },
    ];
    expect(clip(sections, 250)).toEqual({ sections: sections.slice(0, 2), truncated: true });
    expect(clip(sections, 1000)).toEqual({ sections, truncated: false });
    expect(clip(sections.slice(0, 1), 10)).toEqual({ sections: sections.slice(0, 1), truncated: false });
  });

  it("splits a text into paragraph groups the model can answer in one go", () => {
    const paragraph = "Satz eins. ".repeat(50).trim(); // ~550 chars: two fit, three do not
    const text = [paragraph, paragraph, paragraph].join("\n\n");
    const chunks = splitForTranslation(text, TRANSLATION_CHUNK_CHARS);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= TRANSLATION_CHUNK_CHARS)).toBe(true);
    // A single long paragraph is cut at a sentence end.
    const long = "Ein Satz. ".repeat(300).trim();
    const cut = splitForTranslation(long, 500);
    expect(cut.every((c) => c.length <= 500 && c.endsWith("."))).toBe(true);
    expect(cut.join(" ")).toBe(long);
  });

  it("tells the model what to do and what not to", () => {
    const prompt = buildTranslationPrompt("Testo.", "it");
    expect(prompt).toContain("ins Deutsche");
    expect(prompt).toContain('{"text"');
    expect(prompt).toContain("Testo.");
  });

  it("reads the languages the reader understands", () => {
    expect([...keepLanguagesOf("en, IT,,pt-br, nonsense!")]).toEqual(["en", "it", "pt-br"]);
    expect(keepLanguagesOf(undefined).size).toBe(0);
    expect(keepLanguagesOf("de").size).toBe(0);
  });

  it("caps the strip", () => {
    expect(MAX_ARTICLE_PHOTOS).toBeLessThanOrEqual(12);
  });
});
