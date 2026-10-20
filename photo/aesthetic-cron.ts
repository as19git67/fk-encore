/**
 * Every five minutes: settle earlier aesthetic runs and start tonight's when
 * the window is open and the LLM idle (photo/aesthetic-nightly.ts). Outside
 * the window a tick costs two small queries.
 */

import { everyMs, schedule } from "../lib/local-cron";
import { aestheticTick } from "./aesthetic-nightly";
import { realNightDeps } from "./aesthetic-deps";

schedule({
  name: "photo-aesthetic-nightly",
  description: "Score photo aesthetics with Q-Align while the GPU is lent (window under Fotos › Einstellungen › Ästhetik)",
  service: "photo",
  scheduleLabel: "every 5m",
  nextFire: everyMs(5 * 60_000),
  run: () => aestheticTick(realNightDeps()),
});
