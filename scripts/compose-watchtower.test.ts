import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Watchtower updates only the containers named in its command. A service
 * that carries the watchtower scope label but is missing from that list
 * keeps its first image forever — which is how the aesthetic-service missed
 * its protobuf fix. Read as text: the repo has no YAML parser, and the
 * shape of docker-compose.yml is regular enough.
 */

const compose = readFileSync(fileURLToPath(new URL("../docker-compose.yml", import.meta.url)), "utf8");

/** Top-level services: their two-space-indented blocks under `services:`. */
function serviceBlocks(): Map<string, string> {
  const body = compose.split(/^services:\s*$/m)[1]!.split(/^\S/m)[0]!;
  const blocks = new Map<string, string>();
  const parts = body.split(/^ {2}(?=[a-z][\w-]*:\s*$)/m);
  for (const part of parts) {
    const name = /^([a-z][\w-]*):/.exec(part)?.[1];
    if (name) blocks.set(name, part);
  }
  return blocks;
}

describe("watchtower in docker-compose.yml", () => {
  it("names every container that carries its scope label", () => {
    const blocks = serviceBlocks();
    const watchtower = blocks.get("watchtower");
    expect(watchtower, "watchtower service").toBeDefined();
    const command = /command:\s*>([\s\S]*?)\n {4}\S/.exec(watchtower!)?.[1] ?? "";
    const watched = new Set(command.match(/fk-encore-[a-z-]+/g) ?? []);

    const labelled = [...blocks.entries()]
      .filter(([name, block]) => name !== "watchtower" && block.includes("com.centurylinklabs.watchtower.scope"))
      .map(([name, block]) => ({ name, container: /container_name:\s*(fk-encore-[a-z-]+)/.exec(block)?.[1] }));

    expect(labelled.length).toBeGreaterThan(5);
    for (const { name, container } of labelled) {
      expect(container, `${name} has a container_name`).toBeDefined();
      expect(watched.has(container!), `${container} (${name}) is in the watchtower command`).toBe(true);
    }
  });
});
