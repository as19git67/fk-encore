import { describe, expect, it } from "vitest";
import { cacheControlFor } from "./static-cache";

describe("cacheControlFor", () => {
  it("requires revalidation for the SPA shell", () => {
    expect(cacheControlFor("/srv/frontend/dist/index.html"))
      .toBe("no-cache, must-revalidate");
  });

  it("keeps content-hashed Vite assets immutable", () => {
    expect(cacheControlFor("/srv/frontend/dist/assets/app-a1b2c3.js"))
      .toBe("public, max-age=31536000, immutable");
  });

  it("requires revalidation for non-hashed public files", () => {
    expect(cacheControlFor("/srv/frontend/dist/push-sw.js"))
      .toBe("no-cache, must-revalidate");
  });
});
