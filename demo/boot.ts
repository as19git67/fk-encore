/**
 * The boot switch `DEMO_DATA` (documentation/plans/demodaten.md): a test
 * installation or the demo deployment loads the demo once at boot, through
 * the same run as the button on Admin › Systemstatus, loaded by the admin
 * from `ADMIN_EMAIL` and owned by the demo owner from `DEMO_OWNER_EMAIL`
 * (demo/owner.ts) or, without one, by that admin; only while the system is
 * untouched.
 *
 *   DEMO_DATA=1 (true, yes, on, full)  the full demo, worded by the model
 *   DEMO_DATA=small                    the small household of the E2E
 *                                      tests, worded from the templates
 *
 * Anything else, or nothing, leaves the boot alone. A system that holds a
 * demo or anything else already is never touched, so a restart does not
 * load the demo twice.
 */

import { eq } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import { users } from "../db/schema";
import type { TextSource } from "./doc-writer";
import type { DemoSize } from "./household";
import { DemoRefused, executeRun, fileRun, type StartOptions } from "./run";
import { demoOwnerFor, demoOwnerSetting, type DemoOwnerSetting } from "./owner";
import { currentRun } from "./state";

export interface BootDemo {
  size: DemoSize;
  text: TextSource;
}

/** What `DEMO_DATA` asks for; null when it asks for nothing. */
export function demoDataSetting(value: string | undefined = process.env.DEMO_DATA): BootDemo | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "small") return { size: "small", text: "template" };
  if (["1", "true", "yes", "on", "full"].includes(v)) return { size: "full", text: "llm" };
  return null;
}

export type BootOutcome = "off" | "no_admin" | "exists" | "refused" | "loaded";

/**
 * Loads the demo `setting` asks for and waits for it. Never throws: the
 * outcome of the run is in its row, and the reason it did not start is
 * logged and returned.
 */
export async function loadDemoAtBoot(
  setting: BootDemo | null = demoDataSetting(),
  adminEmail: string = process.env.ADMIN_EMAIL || "admin@example.com",
  opts: Omit<StartOptions, "size" | "text"> = {},
  owner: DemoOwnerSetting | null = demoOwnerSetting(),
): Promise<BootOutcome> {
  if (!setting) return "off";
  try {
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, adminEmail));
    if (!admin) {
      log.warn("DEMO_DATA: the admin user does not exist, no demo loaded", { adminEmail });
      return "no_admin";
    }
    const existing = await currentRun();
    if (existing) {
      log.info("DEMO_DATA: a demo exists already, nothing loaded", { runId: existing.id, status: existing.status });
      return "exists";
    }
    let runId: number;
    try {
      runId = await fileRun(await demoOwnerFor(admin.id, owner), { ...opts, size: setting.size, text: setting.text });
    } catch (err) {
      if (!(err instanceof DemoRefused)) throw err;
      log.info(`DEMO_DATA: ${err.message}`);
      return "refused";
    }
    log.info("DEMO_DATA: loading the demo", { runId, size: setting.size });
    await executeRun(runId, opts);
    return "loaded";
  } catch (err) {
    log.error(err as Error, "DEMO_DATA: loading the demo at boot failed");
    return "refused";
  }
}
