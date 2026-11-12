import { describe, expect, it } from "vitest";
import { areaHotels, hotelClasses, ratingCode } from "./hotel-area";

/** A synthetic Google Hotels result list in SerpApi's shape. */
export const AREA_LIST = {
  properties: [
    { type: "hotel", name: "Hotel Nord", property_token: "tok-nord", rate_per_night: { extracted_lowest: 180 }, extracted_hotel_class: 4, overall_rating: 4.3 },
    { type: "hotel", name: "Hotel Süd", property_token: "tok-sued", rate_per_night: { extracted_lowest: 120 }, hotel_class: "4-Sterne-Hotel", overall_rating: 4.1 },
    { type: "hotel", name: "Hotel Ost", property_token: "tok-ost", rate_per_night: { extracted_lowest: 90 }, extracted_hotel_class: 3, overall_rating: 4.6 },
    { type: "hotel", name: "Hotel West", property_token: "tok-west", rate_per_night: { extracted_lowest: 150 }, extracted_hotel_class: 5, overall_rating: 3.9 },
    { type: "vacation rental", name: "Ferienwohnung Mitte", property_token: "tok-fewo", rate_per_night: { extracted_lowest: 60 } },
    { type: "hotel", name: "Hotel ohne Preis", property_token: "tok-leer", extracted_hotel_class: 5, overall_rating: 4.8 },
  ],
};

describe("areaHotels", () => {
  it("keeps the hotels that meet stars and rating, cheapest first", () => {
    expect(areaHotels(AREA_LIST, { minStars: 4, minRating: 4 }).map((h) => h.name)).toEqual(["Hotel Süd", "Hotel Nord"]);
    expect(areaHotels(AREA_LIST, { minStars: null, minRating: 4.5 }).map((h) => h.name)).toEqual(["Hotel Ost"]);
  });

  it("leaves out rentals and hotels without a price", () => {
    expect(areaHotels(AREA_LIST, { minStars: null, minRating: null }).map((h) => h.token)).toEqual([
      "tok-ost",
      "tok-sued",
      "tok-west",
      "tok-nord",
    ]);
  });

  it("reads the stars from the text when the number is missing", () => {
    expect(areaHotels(AREA_LIST, { minStars: 4, minRating: null }).find((h) => h.name === "Hotel Süd")?.stars).toBe(4);
  });
});

describe("filter codes", () => {
  it("translate rating and stars into SerpApi's parameters", () => {
    expect(ratingCode(null)).toBeNull();
    expect(ratingCode(3.5)).toBe(7);
    expect(ratingCode(4)).toBe(8);
    expect(ratingCode(4.5)).toBe(9);
    expect(hotelClasses(null)).toEqual([]);
    expect(hotelClasses(4)).toEqual([4, 5]);
  });
});
