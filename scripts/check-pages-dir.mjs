// docs/ is the GitHub Pages root: everything in it is published.
// Documentation lives in documentation/. Fail if docs/ holds anything else.
import { readdirSync } from "node:fs";

const ALLOWED = new Set(["index.html", "assets"]);
const extra = readdirSync("docs").filter((name) => !ALLOWED.has(name));

if (extra.length > 0) {
  console.error(
    `docs/ is published as the website and may only contain index.html and assets/.\n` +
      `Move these to documentation/: ${extra.join(", ")}`,
  );
  process.exit(1);
}
