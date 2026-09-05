/*
 * Read the open page, in the page (§9.3 stage 1).
 *
 * The obvious design shares only the URL and lets the server fetch it.
 * The concept rejects that as the *primary* route for four reasons, all
 * of which this file sidesteps by running where the page already is:
 * JavaScript-rendered pages, cookie banners, a login or paywall, and
 * bot blocks against datacentre addresses. The reader's own browser has
 * already solved the hard part; the server fetch stays as the fallback
 * for a bare link out of a chat app.
 *
 * Scope is deliberately narrow: get the visible words out and hand them
 * over. Deciding *what is a place* is the model's job, on the server,
 * against a strict schema with a verbatim quote (§9.3 stage 3) — none
 * of that belongs in an unsandboxed script running inside somebody
 * else's page.
 */

/* global document */

/** Beyond this the extra text is boilerplate, and the server trims to
 *  24 000 anyway — at a sentence boundary, which it can do and we
 *  cannot without duplicating that logic here. */
var MAX_CHARACTERS = 40000;

/** Chrome, not content. Removed before reading so a cookie banner and a
 *  "you may also like" rail do not crowd out the article: for a small
 *  local model context is the scarcest resource there is (§9.3 stage 2). */
var FURNITURE = "nav, aside, footer, header, form, script, style, noscript, "
    + "template, iframe, svg, button, [role=navigation], [role=banner], "
    + "[role=complementary], [role=search], [aria-hidden=true]";

/** Where an article usually lives, best guess first. */
var ARTICLE_SELECTORS = ["article", "main", "[role=main]", "#content", ".post", ".entry-content"];

/** Block-level enough that running the text together would change what
 *  it says. "Café am BeispielplatzÖffnungszeiten" is one word to an
 *  extraction model, and the wrong one. */
var BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H1|H2|H3|H4|H5|H6|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/;

/** Is this element actually on the screen?
 *
 *  Checked on the live element, which is the whole reason the walk below
 *  does not work on a clone: a detached node has no layout, so
 *  `innerText` degrades to `textContent` there — hidden tabs, screen
 *  reader labels and the collapsed half of every accordion come back
 *  along with the article, and the block boundaries do not. */
function isVisible(element) {
    if (element.hidden) { return false; }
    if (element.getClientRects().length > 0) { return true; }
    // A block with no rects can still be a wrapper whose children are
    // positioned; only trust the negative when the style says so too.
    var style = element.ownerDocument.defaultView.getComputedStyle(element);
    return !(style.display === "none" || style.visibility === "hidden");
}

/** The visible words under a node, with the line breaks its structure
 *  implies. Reads the page as it stands and changes nothing: the reader
 *  is still looking at it after the share sheet closes, and a script
 *  that guts the page is a bug they will blame on the site. */
function visibleText(root) {
    if (!root) { return ""; }
    var pieces = [];

    function walk(node) {
        if (node.nodeType === 3) {                      // text
            pieces.push(node.nodeValue);
            return;
        }
        if (node.nodeType !== 1) { return; }            // comment, etc.
        if (node.matches && node.matches(FURNITURE)) { return; }
        if (!isVisible(node)) { return; }

        var isBlock = BLOCK.test(node.tagName);
        if (isBlock) { pieces.push("\n"); }
        for (var child = node.firstChild; child; child = child.nextSibling) {
            walk(child);
        }
        if (isBlock) { pieces.push("\n"); }
    }

    walk(root);
    return pieces.join("")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** The longest of the plausible article containers, falling back to the
 *  body. Longest rather than first because a page can carry an empty
 *  <main> wrapping the real <article>, and a page can carry an <article>
 *  per teaser on a list page. */
function articleText() {
    var best = "";
    for (var i = 0; i < ARTICLE_SELECTORS.length; i++) {
        var nodes = document.querySelectorAll(ARTICLE_SELECTORS[i]);
        for (var n = 0; n < nodes.length; n++) {
            var text = visibleText(nodes[n]);
            if (text.length > best.length) { best = text; }
        }
    }
    var whole = visibleText(document.body);
    // A container that holds almost nothing next to the page as a whole
    // is the wrong container — a shell around a JavaScript-rendered
    // article, say. Trust the body then and let the server's own
    // extraction cope.
    if (best.length < 200 || best.length * 4 < whole.length) { best = whole; }
    return best.slice(0, MAX_CHARACTERS);
}

function pageTitle() {
    var og = document.querySelector("meta[property='og:title']");
    var fromMeta = og && og.getAttribute("content");
    return (fromMeta || document.title || "").trim().slice(0, 300);
}

/** The canonical link if the page names one: a share from a page reached
 *  through a tracking redirect should record where it actually lives. */
function pageURL() {
    var canonical = document.querySelector("link[rel=canonical]");
    var href = canonical && canonical.getAttribute("href");
    if (href && href.indexOf("https://") === 0) { return href; }
    return document.location.href;
}

/** Whatever the reader had selected. Handed over separately: a selection
 *  is a deliberate act and says more about intent than the surrounding
 *  page does — "this café", not "the eleven cafés in this list". */
function selectedText() {
    var selection = document.getSelection();
    var text = selection ? String(selection) : "";
    return text.replace(/[^\S\n]+/g, " ").trim().slice(0, MAX_CHARACTERS);
}

var ExtensionPreprocessingJS = {
    run: function (parameters) {
        parameters.completionFunction({
            url: pageURL(),
            title: pageTitle(),
            text: articleText(),
            selection: selectedText(),
        });
    },
    // Nothing to write back into the page. The extension captures and
    // hands off; it does not act on the page it read.
    finalize: function () {},
};
