import { describe, expect, it } from "vitest";
import {
  getDockerDriver,
  InMemoryDockerDriver,
  setDockerDriver,
} from "./docker-driver";

describe("InMemoryDockerDriver", () => {
  it("transitions container states via ensureRunning / stop / remove", async () => {
    const d = new InMemoryDockerDriver();
    const before = await d.inspect("x");
    expect(before.state).toBe("missing");

    await d.ensureRunning({ name: "x", image: "img" });
    expect((await d.inspect("x")).state).toBe("running");

    await d.stop("x");
    expect((await d.inspect("x")).state).toBe("exited");

    await d.remove("x");
    expect((await d.inspect("x")).state).toBe("missing");
  });

  it("records every operation in events for assertions", async () => {
    const d = new InMemoryDockerDriver();
    await d.ensureRunning({ name: "a", image: "img" });
    await d.waitHealthy("http://a/status");
    await d.stop("a");
    await d.remove("a");
    await d.removeVolume("a-vol");
    expect(d.events).toEqual([
      { op: "ensureRunning", name: "a" },
      { op: "waitHealthy", url: "http://a/status", healthy: true },
      { op: "stop", name: "a" },
      { op: "remove", name: "a" },
      { op: "removeVolume", name: "a-vol" },
    ]);
  });

  it("removeVolume is idempotent for unknown volumes", async () => {
    const d = new InMemoryDockerDriver();
    await expect(d.removeVolume("nope")).resolves.toBeUndefined();
  });

  it("waitHealthy honours the configured healthyByDefault flag", async () => {
    const d = new InMemoryDockerDriver();
    d.healthyByDefault = false;
    expect(await d.waitHealthy("http://x/status")).toBe(false);
  });
});

describe("driver singleton", () => {
  it("getDockerDriver returns the most recently set driver", () => {
    const original = getDockerDriver();
    try {
      const replacement = new InMemoryDockerDriver();
      setDockerDriver(replacement);
      expect(getDockerDriver()).toBe(replacement);
    } finally {
      setDockerDriver(original);
    }
  });
});
