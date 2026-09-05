import { describe, expect, it } from "vitest";
import { parseBareCoordinates, parseMapLink } from "./map-link";

/**
 * Coordinates in these fixtures are invented points near Augsburg, not
 * anybody's location, and the names are made up.
 */
describe("parseMapLink", () => {
  describe("Apple Maps", () => {
    it("reads the place out of an ll link", () => {
      const link = parseMapLink("https://maps.apple.com/?ll=48.3705,10.8978&q=Beispielmuseum");
      expect(link?.source).toBe("apple");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
      expect(link?.name).toBe("Beispielmuseum");
    });

    it("reads the newer coordinate parameter", () => {
      const link = parseMapLink(
        "https://maps.apple.com/place?coordinate=48.3705,10.8978&name=Beispielkirche",
      );
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
      expect(link?.name).toBe("Beispielkirche");
    });

    it("ignores the search location, which is not the place", () => {
      // `sll` is where the map was looking when the search ran. Taking
      // it would answer "the middle of town" for a link that means a
      // bakery somewhere in it.
      const link = parseMapLink("https://maps.apple.com/?q=B%C3%A4ckerei&sll=48.3705,10.8978");
      expect(link?.position).toBeNull();
      expect(link?.name).toBe("Bäckerei");
    });
  });

  describe("Google Maps", () => {
    it("prefers the pin in the data segment over the map centre", () => {
      const link = parseMapLink(
        "https://www.google.com/maps/place/Beispielcaf%C3%A9/@48.3700,10.8900,17z/"
          + "data=!3m1!4b1!4m5!3m4!1s0x0:0x0!8m2!3d48.3705!4d10.8978",
      );
      expect(link?.source).toBe("google");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
      expect(link?.name).toBe("Beispielcafé");
    });

    it("falls back to the map centre when there is no pin", () => {
      const link = parseMapLink("https://www.google.com/maps/place/Beispielpark/@48.3705,10.8978,15z");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
      expect(link?.name).toBe("Beispielpark");
    });

    it("reads a coordinate out of the query parameter", () => {
      const link = parseMapLink("https://www.google.com/maps/search/?api=1&query=48.3705,10.8978");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
      expect(link?.name).toBeNull();
    });

    it("understands the loc: prefix", () => {
      const link = parseMapLink("https://maps.google.com/?q=loc:48.3705,10.8978");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
    });

    it("keeps a search term as a name, not as a position", () => {
      const link = parseMapLink("https://www.google.com/maps?q=Beispielmuseum+Musterstadt");
      expect(link?.position).toBeNull();
      expect(link?.name).toBe("Beispielmuseum Musterstadt");
    });

    it("reports a short link as needing its redirect followed", () => {
      const link = parseMapLink("https://maps.app.goo.gl/AbCdEfGhIjK");
      expect(link?.needsRedirect).toBe(true);
      expect(link?.position).toBeNull();
      expect(link?.name).toBeNull();
    });
  });

  describe("other formats", () => {
    it("reads an OpenStreetMap marker", () => {
      const link = parseMapLink("https://www.openstreetmap.org/?mlat=48.3705&mlon=10.8978#map=17/48.3705/10.8978");
      expect(link?.source).toBe("osm");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
    });

    it("reads an OpenStreetMap view when there is no marker", () => {
      const link = parseMapLink("https://www.openstreetmap.org/#map=17/48.3705/10.8978");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
    });

    it("reads a geo: URI with its label", () => {
      const link = parseMapLink("geo:48.3705,10.8978?q=48.3705,10.8978(Beispielhaus)");
      expect(link?.source).toBe("geo");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
      expect(link?.name).toBe("Beispielhaus");
    });

    it("reads a pasted pair of coordinates", () => {
      const link = parseMapLink(" 48.3705, 10.8978 ");
      expect(link?.source).toBe("coordinates");
      expect(link?.position).toEqual({ lat: 48.3705, lon: 10.8978 });
    });
  });

  describe("what it refuses", () => {
    it("answers null for a link from somewhere else entirely", () => {
      expect(parseMapLink("https://beispiel.test/artikel/zehn-cafes")).toBeNull();
      expect(parseMapLink("nicht einmal eine URL")).toBeNull();
      expect(parseMapLink("   ")).toBeNull();
    });

    it("refuses numbers that cannot be a position", () => {
      // A latitude of 148 means the link was misread. Answering null
      // sends the caller to its confirmation map instead of dropping a
      // pin somewhere impossible.
      const link = parseMapLink("https://maps.apple.com/?ll=148.37,10.8978");
      expect(link?.position).toBeNull();
    });

    it("treats 0,0 as a link that lost its coordinates", () => {
      const link = parseMapLink("https://maps.apple.com/?ll=0,0&q=Irgendwo");
      expect(link?.position).toBeNull();
      expect(link?.name).toBe("Irgendwo");
    });

    it("does not mistake an identifier for a name", () => {
      const link = parseMapLink("https://www.google.com/maps?q=ChIJAAAAAAAAAAARAAAAAAAAAAA");
      expect(link?.name).toBeNull();
    });

    it("does not read a place out of a sentence with numbers in it", () => {
      expect(parseBareCoordinates("wir waren 4.5, 3 Stunden dort")).toBeNull();
      expect(parseBareCoordinates("48.3705")).toBeNull();
    });
  });
});
