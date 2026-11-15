import { afterEach, describe, expect, it } from "vitest";

import { mailConfigured } from "./mail";

/** Mail in the dev stack (lib/environment.ts): redirected by default, off on request. */
describe("mail in the dev stack", () => {
  afterEach(() => {
    delete process.env.APP_ENVIRONMENT;
    delete process.env.DEV_OUTBOUND_MAIL;
  });

  it("counts as configured while it goes to the mail catcher, without an SMTP account", () => {
    process.env.APP_ENVIRONMENT = "dev";
    expect(mailConfigured()).toBe(true);
  });

  it("is not configured when the env file switches it off", () => {
    process.env.APP_ENVIRONMENT = "dev";
    process.env.DEV_OUTBOUND_MAIL = "off";
    expect(mailConfigured()).toBe(false);
  });
});
