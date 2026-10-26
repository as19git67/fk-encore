import type { Area } from "./index";

export const TRIPS_AREA: Area = {
  id: "trips",
  description: "Reisen: trip plans in preparation or done, and the trips the photo recaps show for a year.",
  tools: ["list_trip_plans"],
  borrows: ["list_recaps"],
  rules: [],
  examples: [
    '"Welche Urlaubsreisen haben wir letztes Jahr gemacht?" → list_recaps(kind = "trip", year = last year) and list_trip_plans together → name the trips both found; "was haben wir in Planung" is list_trip_plans alone.',
  ],
  keywords: "reise|urlaub|unterwegs|ausflug|trip|travel|vacation|holiday",
};
