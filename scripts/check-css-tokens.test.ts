import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The colour audit is what keeps dark mode from breaking one view at a time
 * (issue #1281), and it runs in the pre-commit hook — so it has to be exact
 * about what it refuses. A false positive there stops a commit for nothing;
 * a false negative lets a hard-coded grey through.
 */

const SCRIPT = join(import.meta.dirname, "check-css-tokens.mjs");
let dir: string;

function check(name: string, content: string): { code: number; output: string } {
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  try {
    const stdout = execFileSync("node", [SCRIPT, file], { encoding: "utf8" });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "css-audit-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("colour audit", () => {
  it("passes styles that ask the theme", () => {
    const { code } = check(
      "clean.vue",
      `<template><i /></template>
<style scoped>
.card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  color: var(--p-text-muted-color);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  outline-color: rgb(0 0 0 / 45%);
}
</style>`,
    );
    expect(code).toBe(0);
  });

  it("refuses a rung of the surface scale", () => {
    const { code, output } = check(
      "surface.vue",
      `<style scoped>.a { background: var(--p-surface-100); }</style>`,
    );
    expect(code).toBe(1);
    expect(output).toContain("--p-surface-100");
  });

  it("refuses a hard-coded colour in any of its spellings", () => {
    for (const colour of ["#fff", "#1f2937", "#11223344"]) {
      const { code, output } = check("hex.vue", `<style>.a { color: ${colour}; }</style>`);
      expect(code, colour).toBe(1);
      expect(output).toContain(colour);
    }
  });

  it("refuses an opaque rgb, and accepts a translucent one", () => {
    expect(check("opaque.vue", `<style>.a { color: rgb(17, 24, 39); }</style>`).code).toBe(1);
    expect(check("opaque2.vue", `<style>.a { color: rgba(17, 24, 39, 1); }</style>`).code).toBe(1);
    expect(check("alpha.vue", `<style>.a { color: rgba(17, 24, 39, 0.4); }</style>`).code).toBe(0);
    expect(check("alpha2.vue", `<style>.a { color: rgb(17 24 39 / 40%); }</style>`).code).toBe(0);
  });

  it("reads the alpha through a var(), where the closing bracket is not the last", () => {
    // `[^)]*` stopped at the bracket closing `var(`, so the alpha was never
    // seen and the very escape hatch CLAUDE.md prescribes was refused.
    expect(
      check("varalpha.vue", `<style>.a { box-shadow: 0 0 0 3px rgba(var(--p-primary-500-rgb), 0.35); }</style>`)
        .code,
    ).toBe(0);
    expect(
      check("relative.vue", `<style>.a { color: rgb(from var(--p-primary-color) r g b / 50%); }</style>`).code,
    ).toBe(0);
    // And an opaque one written the same way is still refused.
    expect(
      check("varopaque.vue", `<style>.a { color: rgba(var(--p-primary-500-rgb), 1); }</style>`).code,
    ).toBe(1);
  });

  it("reads styles only — a colour in the markup or the script is not styling", () => {
    const { code } = check(
      "elsewhere.vue",
      `<script setup lang="ts">const seriesColour = '#2563eb'</script>
<template><svg><path fill="#ff0000" /></svg></template>
<style scoped>.a { color: var(--p-text-color); }</style>`,
    );
    expect(code).toBe(0);
  });

  it("does not mistake an issue number in a comment for a colour", () => {
    const { code } = check(
      "comment.vue",
      `<style scoped>
/* Lifted into the sticky stack (#1272), see also #736 and #1281. */
.a { color: var(--p-text-color); }
</style>`,
    );
    expect(code).toBe(0);
  });

  it("does not mistake an id selector for a colour", () => {
    const { code } = check(
      "selector.vue",
      `<style>#module-subheaders { position: sticky; }</style>`,
    );
    expect(code).toBe(0);
  });

  it("lets a line opt out when it says why", () => {
    const { code } = check(
      "exempt.vue",
      `<style scoped>
.viewer { background: #000; } /* audit-ok: a photo viewer is black in both themes */
</style>`,
    );
    expect(code).toBe(0);
  });

  it("refuses a PrimeVue 3 name, which resolves to nothing today", () => {
    for (const name of ["--surface-border", "--text-color-secondary", "--blue-100"]) {
      const { code, output } = check("legacy.vue", `<style>.a { color: var(${name}); }</style>`);
      expect(code, name).toBe(1);
      expect(output).toContain(name);
    }
  });

  it("keeps this app's own tokens, which start the same way", () => {
    const { code } = check(
      "own-tokens.vue",
      `<style scoped>
.a { font-size: var(--text-md); outline: var(--focus-ring); }
.b { font-size: var(--text-7xl); outline-offset: var(--focus-ring-offset); }
</style>`,
    );
    expect(code).toBe(0);
  });

  it("refuses a literal size, and leaves relative ones alone", () => {
    expect(check("size.vue", `<style>.a { font-size: 0.85rem; }</style>`).code).toBe(1);
    expect(check("size-px.vue", `<style>.a { font-size: 13px; }</style>`).code).toBe(1);
    // `em` and `%` scale with their context by design, `inherit` takes what
    // it is given, and a var() is already a token.
    expect(check("size-em.vue", `<style>.a { font-size: 0.9em; }</style>`).code).toBe(0);
    expect(check("size-inherit.vue", `<style>.a { font-size: inherit; }</style>`).code).toBe(0);
    expect(check("size-var.vue", `<style>.a { font-size: var(--text-base); }</style>`).code).toBe(0);
  });

  it("names the file and the line it found it on", () => {
    const { output } = check(
      "located.vue",
      `<style scoped>
.a { color: var(--p-text-color); }
.b { color: #abcdef; }
</style>`,
    );
    expect(output).toMatch(/located\.vue:3\s+#abcdef/);
  });
});
