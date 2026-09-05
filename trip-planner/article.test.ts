import { describe, expect, it } from "vitest";
import {
  MAX_ARTICLE_CHARS,
  MIN_QUOTE_CHARS,
  articleTextFromHtml,
  prepareArticleText,
  quoteAppearsIn,
} from "./article";

describe("articleTextFromHtml", () => {
  it("keeps the prose and drops the furniture", () => {
    const html = `
      <html><head><style>.x{color:red}</style></head>
      <body>
        <nav><a href="/">Startseite</a><a href="/reisen">Reisen</a></nav>
        <script>window.track({ page: "artikel" });</script>
        <article>
          <h1>Zehn Orte in Beispielstadt</h1>
          <p>Im <b>Beispielcafé</b> gibt es den besten Kuchen der Stadt.</p>
          <p>Das Stadtmuseum lohnt einen Vormittag.</p>
        </article>
        <aside>Das könnte Sie auch interessieren</aside>
        <footer>Impressum</footer>
      </body></html>`;
    const text = articleTextFromHtml(html);

    expect(text).toContain("Beispielcafé");
    expect(text).toContain("Das Stadtmuseum lohnt einen Vormittag.");
    expect(text).not.toContain("window.track");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Startseite");
    expect(text).not.toContain("Impressum");
    expect(text).not.toContain("könnte Sie auch interessieren");
  });

  it("keeps paragraphs apart instead of running them together", () => {
    // "…Kuchen.Das Stadtmuseum…" would hand the model a word that is
    // not in the page, and every quote spanning the join would fail.
    const text = articleTextFromHtml("<p>Erster Satz.</p><p>Zweiter Satz.</p>");
    expect(text).toBe("Erster Satz.\n\nZweiter Satz.");
  });

  it("decodes the entities that turn up in prose", () => {
    const text = articleTextFromHtml("<p>Caf&eacute; &bdquo;Zum M&uuml;hlrad&ldquo; &amp; mehr</p>");
    expect(text).toBe("Café „Zum Mühlrad“ & mehr");
  });

  it("leaves an entity it does not know rather than mangling it", () => {
    expect(articleTextFromHtml("<p>a &weirdthing; b</p>")).toBe("a &weirdthing; b");
  });

  it("lets an unclosed script swallow the rest, as a browser would", () => {
    // A page cut short mid-script would otherwise leave a wall of
    // JavaScript for the model to look for places in.
    expect(articleTextFromHtml("<p>Text<script>broken(")).toBe("Text");
  });

  it("does not let a stray nav swallow the article", () => {
    // The other half of the same decision: furniture is dropped only
    // as a matched pair, or slightly broken markup would report an
    // empty page.
    const text = articleTextFromHtml("<nav><p>Der Artikel steht hier.</p>");
    expect(text).toBe("Der Artikel steht hier.");
  });
});

describe("prepareArticleText", () => {
  it("collapses runaway whitespace", () => {
    expect(prepareArticleText("  viel    Platz \n\n\n\n und  Zeilen  "))
      .toBe("viel Platz\n\nund Zeilen");
  });

  it("cuts at a paragraph boundary when one is near the limit", () => {
    const text = `${"a".repeat(70)}\n${"b".repeat(70)}`;
    expect(prepareArticleText(text, 100)).toBe("a".repeat(70));
  });

  it("cuts mid-paragraph rather than throwing most of it away", () => {
    // The only break sits at 10 of 100 characters. Honouring it would
    // hand the model a tenth of the page.
    const text = `kurz\n${"c".repeat(300)}`;
    expect(prepareArticleText(text, 100)).toHaveLength(100);
  });

  it("leaves a short page alone", () => {
    expect(prepareArticleText("kurz und gut")).toBe("kurz und gut");
    expect(MAX_ARTICLE_CHARS).toBeGreaterThan(1000);
  });
});

describe("quoteAppearsIn", () => {
  const page = "Im Beispielcafé gibt es den besten Kuchen der Stadt – wirklich.";

  it("accepts a quote that is in the page", () => {
    expect(quoteAppearsIn("gibt es den besten Kuchen", page)).toBe(true);
  });

  it("forgives typography the model retyped", () => {
    // Curly quotes as straight ones, an en dash as a hyphen, a line
    // break as a space: none of that is invention.
    expect(quoteAppearsIn("besten  Kuchen\nder Stadt - wirklich", page)).toBe(true);
  });

  it("rejects a quote whose words are not in the page", () => {
    expect(quoteAppearsIn("gibt es den besten Kaffee der Stadt", page)).toBe(false);
  });

  it("rejects a quote too short to prove anything", () => {
    // "der Stadt" is in the page, and in every other page too.
    expect("der Stadt".length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(quoteAppearsIn("der Stadt", page)).toBe(false);
  });
});
