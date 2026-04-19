import { describe, it, expect, beforeEach } from "vitest";
import {
  clearBackupActive,
  getBackupState,
  hasPgBackupStarted,
  isInBackupMode,
  markFailed,
  markPgBackupStarted,
  setBackupActive,
  setPhase,
} from "./state";

describe("backup/state phase machine", () => {
  beforeEach(() => {
    clearBackupActive();
  });

  it("starts idle with no residue", () => {
    const s = getBackupState();
    expect(s.active).toBe(false);
    expect(s.phase).toBe("idle");
    expect(s.label).toBeNull();
    expect(s.error).toBeNull();
    expect(s.dumpFile).toBeNull();
    expect(s.pgBackupStarted).toBe(false);
    expect(isInBackupMode()).toBe(false);
  });

  it("setBackupActive enters draining and carries label + dumpFile", () => {
    const timer = setTimeout(() => {}, 999999);
    setBackupActive("daily-xyz", timer, "/mnt/backup/encore-daily-xyz.dump");

    const s = getBackupState();
    expect(s.active).toBe(true);
    expect(s.phase).toBe("draining");
    expect(s.label).toBe("daily-xyz");
    expect(s.dumpFile).toBe("/mnt/backup/encore-daily-xyz.dump");
    expect(s.startedAt).toBeInstanceOf(Date);
    expect(s.error).toBeNull();
    expect(hasPgBackupStarted()).toBe(false);
    expect(isInBackupMode()).toBe(true);
  });

  it("happy path transitions draining -> dumping -> ready -> idle", () => {
    const timer = setTimeout(() => {}, 999999);
    setBackupActive("daily-1", timer, "/tmp/encore-daily-1.dump");
    expect(getBackupState().phase).toBe("draining");

    setPhase("dumping");
    markPgBackupStarted();
    expect(getBackupState().phase).toBe("dumping");
    expect(hasPgBackupStarted()).toBe(true);

    setPhase("ready");
    expect(getBackupState().phase).toBe("ready");
    expect(isInBackupMode()).toBe(true);

    setPhase("stopping");
    clearBackupActive();
    expect(getBackupState().phase).toBe("idle");
    expect(isInBackupMode()).toBe(false);
    expect(hasPgBackupStarted()).toBe(false);
  });

  it("markFailed preserves label/error but clears the maintenance flag", () => {
    const timer = setTimeout(() => {}, 999999);
    setBackupActive("daily-2", timer, "/tmp/encore-daily-2.dump");
    setPhase("dumping");
    markPgBackupStarted();

    markFailed("pg_dump exited 1: disk full");

    const s = getBackupState();
    expect(s.active).toBe(false);
    expect(s.phase).toBe("failed");
    expect(s.label).toBe("daily-2");
    expect(s.error).toBe("pg_dump exited 1: disk full");
    expect(s.pgBackupStarted).toBe(false);
    expect(isInBackupMode()).toBe(false);
  });

  it("clearBackupActive fully resets state from any phase, including failed", () => {
    const timer = setTimeout(() => {}, 999999);
    setBackupActive("daily-3", timer, "/tmp/encore-daily-3.dump");
    markFailed("boom");
    clearBackupActive();

    const s = getBackupState();
    expect(s.phase).toBe("idle");
    expect(s.label).toBeNull();
    expect(s.error).toBeNull();
    expect(s.dumpFile).toBeNull();
    expect(s.startedAt).toBeNull();
    expect(isInBackupMode()).toBe(false);
  });

  it("setBackupActive clears the auto-stop timer from a previous run", () => {
    let fired = 0;
    const prevTimer = setTimeout(() => {
      fired++;
    }, 10);
    setBackupActive("first", prevTimer, "/tmp/first.dump");

    // Start a second run while the first was still "active" — simulates
    // the paranoid case. The previous timer must be cleared before we
    // arm a new one, otherwise a stale force-stop could fire mid-run.
    clearBackupActive();
    const newTimer = setTimeout(() => {}, 999999);
    setBackupActive("second", newTimer, "/tmp/second.dump");

    // Give the (cancelled) timer time to fire if it would.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(fired).toBe(0);
        expect(getBackupState().label).toBe("second");
        clearTimeout(newTimer);
        resolve();
      }, 50);
    });
  });
});
