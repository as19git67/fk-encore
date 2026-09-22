import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The check runs in the pre-commit hook, so a false positive stops a commit
 * for nothing. Two things it has to get right, because a first version got
 * both wrong: a `>` inside an attribute value must not end the tag, and the
 * hidden measurement row must not be reported.
 */

const SCRIPT = join(import.meta.dirname, "check-button-labels.mjs");
let dir: string;

function check(name: string, content: string): { code: number; output: string } {
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  try {
    return { code: 0, output: execFileSync("node", [SCRIPT, file], { encoding: "utf8" }) };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "button-labels-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("icon button labels", () => {
  it("refuses an icon button that says nothing", () => {
    const { code, output } = check(
      "bare.vue",
      `<template><Button icon="pi pi-trash" text @click="remove" /></template>`,
    );
    expect(code).toBe(1);
    expect(output).toContain("pi pi-trash");
  });

  it("accepts a visible label, an aria-label or a tooltip", () => {
    expect(check("a.vue", `<template><Button icon="pi pi-trash" label="Löschen" /></template>`).code).toBe(0);
    expect(check("b.vue", `<template><Button icon="pi pi-trash" aria-label="Löschen" /></template>`).code).toBe(0);
    expect(check("c.vue", `<template><Button icon="pi pi-trash" v-tooltip="'Löschen'" /></template>`).code).toBe(0);
    expect(
      check("d.vue", `<template><Button :icon="i" :aria-label="hidden ? 'Zeigen' : 'Verbergen'" /></template>`).code,
    ).toBe(0);
  });

  it("does not stop at a > inside an attribute value", () => {
    // The arrow function ends the tag for a naive regex, which then reads
    // the attributes that follow as if they were not there.
    const { code } = check(
      "arrow.vue",
      `<template>
  <Button
    icon="pi pi-times"
    @click="(v) => close(v)"
    aria-label="Schließen"
  />
</template>`,
    );
    expect(code).toBe(0);
  });

  it("leaves a button nobody can hear alone", () => {
    // ResponsiveToolbar renders a copy of every item off-stage to measure
    // it; an aria-hidden subtree is never announced.
    const { code } = check(
      "measure.vue",
      `<template>
  <div class="measure" aria-hidden="true">
    <Button icon="pi pi-ellipsis-v" text />
  </div>
</template>`,
    );
    expect(code).toBe(0);
  });

  it("still reports a button after that subtree closes", () => {
    const { code, output } = check(
      "after.vue",
      `<template>
  <div aria-hidden="true"><Button icon="pi pi-ellipsis-v" /></div>
  <Button icon="pi pi-trash" />
</template>`,
    );
    expect(code).toBe(1);
    expect(output).toContain("pi pi-trash");
    expect(output).not.toContain("ellipsis");
  });

  it("keeps the hidden subtree open across a child of the same name", () => {
    // Looking for the first `</div>` ended the subtree at the inner row, so
    // the second button was reported although nothing announces it.
    const { code } = check(
      "nested-hidden.vue",
      `<template>
        <div aria-hidden="true">
          <div class="row"><Button icon="pi pi-a" /></div>
          <Button icon="pi pi-b" />
        </div>
      </template>`,
    );
    expect(code).toBe(0);
  });

  it("recognises the hidden container even with a > in an earlier attribute", () => {
    // The marker regex could not pass a `>` inside an attribute value, so a
    // handler written before `aria-hidden` hid the container from the check
    // — the same pitfall the tag walker was written to avoid.
    const { code } = check(
      "hidden-arrow.vue",
      `<template>
        <div @click="() => open()" aria-hidden="true"><Button icon="pi pi-c" /></div>
      </template>`,
    );
    expect(code).toBe(0);
  });

  it("counts the text between the tags as the label", () => {
    const { code } = check(
      "slot-text.vue",
      `<template>
        <Button icon="pi pi-plus">Neu anlegen</Button>
        <Button icon="pi pi-tag">{{ label }}</Button>
      </template>`,
    );
    expect(code).toBe(0);
  });

  it("is not fooled by an icon standing in for the text", () => {
    const { code, output } = check(
      "slot-icon.vue",
      `<template><Button icon="pi pi-cog"><i class="pi pi-inner" /></Button></template>`,
    );
    expect(code).toBe(1);
    expect(output).toContain("pi pi-cog");
  });

  it("leaves a ButtonGroup alone, which only starts the same way", () => {
    const { code } = check(
      "group.vue",
      `<template>
        <ButtonGroup icon="pi pi-x"><Button icon="pi pi-y" aria-label="Ypsilon" /></ButtonGroup>
      </template>`,
    );
    expect(code).toBe(0);
  });

  it("names the file and the line", () => {
    const { output } = check(
      "located.vue",
      `<template>
  <Button icon="pi pi-check" aria-label="Speichern" />
  <Button icon="pi pi-pencil" />
</template>`,
    );
    expect(output).toMatch(/located\.vue:3/);
  });
});
