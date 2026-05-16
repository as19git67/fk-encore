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
    await d.runOneShot({ name: "b", image: "img" });
    await d.stop("a");
    await d.remove("a");
    expect(d.events).toEqual([
      { op: "ensureRunning", name: "a" },
      { op: "runOneShot", name: "b", exitCode: 0 },
      { op: "stop", name: "a" },
      { op: "remove", name: "a" },
    ]);
  });

  it("honours the configured oneShotExitCode", async () => {
    const d = new InMemoryDockerDriver();
    d.oneShotExitCode = 42;
    const exit = await d.runOneShot({ name: "x", image: "img" });
    expect(exit).toBe(42);
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
