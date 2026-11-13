import { describe, expect, it } from "vitest";
import { durableLink, isGoogleLink, portalSearchLink, unwrapRedirect, type LinkContext } from "./offer-links";

const CTX: LinkContext = {
  hotelName: "Hotel Beispiel Musterstadt",
  checkIn: "2027-05-12",
  checkOut: "2027-05-14",
  adults: 2,
  childrenAges: [],
  rooms: 1,
  propertyToken: "tok-beispiel",
};

describe("durableLink", () => {
  it("keeps a direct link to the provider", () => {
    expect(durableLink("https://portal-a.example/hotel", "Portal A", CTX)).toBe("https://portal-a.example/hotel");
  });

  it("takes the target a redirect carries", () => {
    const link = "https://www.google.de/aclk?sa=l&adurl=https%3A%2F%2Fportal-a.example%2Fhotel%3Fid%3D1";
    expect(unwrapRedirect(link)).toBe("https://portal-a.example/hotel?id=1");
    expect(durableLink(link, "Portal A", CTX)).toBe("https://portal-a.example/hotel?id=1");
    // A target that is Google again does not count.
    expect(unwrapRedirect("https://www.google.com/aclk?adurl=https%3A%2F%2Fwww.google.com%2Ftravel")).toBeNull();
  });

  it("sends the hotel's own offer to its website", () => {
    const ctx = { ...CTX, hotelSite: "https://hotel-beispiel.example/" };
    expect(durableLink("https://www.google.com/aclk?sa=l&ai=x", "Hotel Beispiel", ctx, true)).toBe("https://hotel-beispiel.example/");
    expect(durableLink("https://www.google.com/aclk?sa=l&ai=x", "Portal F", ctx, false)).not.toBe("https://hotel-beispiel.example/");
  });

  it("searches a known portal for the hotel and the stay", () => {
    const booking = new URL(durableLink("https://www.google.com/travel/clk?pc=x", "Booking.com", { ...CTX, adults: 4, rooms: 2 })!);
    expect(booking.hostname).toBe("www.booking.com");
    expect(Object.fromEntries(booking.searchParams)).toMatchObject({
      ss: "Hotel Beispiel Musterstadt",
      checkin: "2027-05-12",
      checkout: "2027-05-14",
      group_adults: "4",
      no_rooms: "2",
      group_children: "0",
    });
    const expedia = new URL(portalSearchLink("Expedia.de", { ...CTX, childrenAges: [5, 9] })!);
    expect(expedia.hostname).toBe("www.expedia.de");
    expect(expedia.searchParams.get("children")).toBe("1_5,1_9");
    expect(new URL(portalSearchLink("Hotels.com", CTX)!).hostname).toBe("de.hotels.com");
    expect(portalSearchLink("Portal F", CTX)).toBeNull();
  });

  it("falls back to the hotel's Google Hotels page", () => {
    expect(durableLink("https://www.google.com/aclk?sa=l", "Portal F", CTX)).toBe(
      "https://www.google.com/travel/hotels/entity/tok-beispiel/prices?hl=de&gl=de",
    );
    expect(durableLink(null, "Portal F", { ...CTX, propertyToken: null })).toBe(
      "https://www.google.com/travel/search?q=Hotel+Beispiel+Musterstadt&hl=de&gl=de",
    );
  });

  it("knows Google's ad and redirect hosts", () => {
    expect(isGoogleLink("https://www.googleadservices.com/pagead/aclk?x=1")).toBe(true);
    expect(isGoogleLink("https://ad.doubleclick.net/x")).toBe(true);
    expect(isGoogleLink("https://www.google.co.uk/aclk")).toBe(true);
    expect(isGoogleLink("https://google.example/")).toBe(false);
    expect(isGoogleLink("https://notgoogle.com/")).toBe(false);
  });
});
