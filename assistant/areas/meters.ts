import type { Area } from "./index";

export const METERS_AREA: Area = {
  id: "meters",
  description: "Zähler: utility meters (electricity, water, gas, heat), their latest readings and the consumption of a period.",
  tools: ["list_meters", "latest_readings", "consumption_report"],
  rules: [],
  examples: [
    '"Wie viel Strom haben wir letztes Jahr verbraucht?" → list_meters → consumption_report(meter_id = the electricity meter, from/to = last year) → state the total the tool printed.',
  ],
  keywords:
    "z[äa]hler|stromz|wasserz|gasz|strom|wasser|gas|verbrauch|zählerstand|kwh|wärme|heizung|"
    + "meter|readings?|consumption|electricity|water",
};
