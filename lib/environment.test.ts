import { afterEach, describe, expect, it } from "vitest";

import { assertOutbound, isDev, jobOffInDev, outbound, outboundModes, OutboundOffError } from "./environment";

/** The dev stack's outbound modes (documentation/plans/dev-system.md). */

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key === "APP_ENVIRONMENT" || key.startsWith("DEV_OUTBOUND_")) delete process.env[key];
  }
  Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([k]) => k === "APP_ENVIRONMENT" || k.startsWith("DEV_OUTBOUND_"))));
});

describe("outbound", () => {
  it("leaves every path on outside the dev stack, whatever DEV_OUTBOUND_* says", () => {
    delete process.env.APP_ENVIRONMENT;
    process.env.DEV_OUTBOUND_MAIL = "off";
    expect(isDev()).toBe(false);
    expect(Object.values(outboundModes()).every((m) => m === "on")).toBe(true);
    expect(jobOffInDev("finance-sync-statements")).toBe(false);
  });

  it("redirects mail and keeps everything else off by default in dev", () => {
    process.env.APP_ENVIRONMENT = "dev";
    expect(outboundModes()).toEqual({
      mail: "redirect",
      push: "off",
      fints: "off",
      serpapi: "off",
      eodhd: "off",
      print: "off",
      llm: "off",
    });
    expect(() => assertOutbound("fints")).toThrow(OutboundOffError);
    expect(assertOutbound("mail")).toBe("redirect");
  });

  it("takes the mode per path from the env file, and reads redirect as off where there is no target", () => {
    process.env.APP_ENVIRONMENT = "dev";
    process.env.DEV_OUTBOUND_PUSH = "on";
    process.env.DEV_OUTBOUND_MAIL = "OFF";
    process.env.DEV_OUTBOUND_SERPAPI = "redirect";
    process.env.DEV_OUTBOUND_PRINT = "redirect";
    process.env.DEV_OUTBOUND_EODHD = "maybe";
    expect(outbound("push")).toBe("on");
    expect(outbound("mail")).toBe("off");
    expect(outbound("serpapi")).toBe("off");
    expect(outbound("print")).toBe("redirect");
    expect(outbound("eodhd")).toBe("off");
  });

  it("holds a job while one of its paths is off", () => {
    process.env.APP_ENVIRONMENT = "dev";
    expect(jobOffInDev("travel-hotel-watches")).toBe(true);
    expect(jobOffInDev("guest-digest")).toBe(false); // mail is redirected
    expect(jobOffInDev("osm-admin-importer")).toBe(false); // public data
    process.env.DEV_OUTBOUND_SERPAPI = "on";
    expect(jobOffInDev("travel-hotel-watches")).toBe(false);
  });
});
