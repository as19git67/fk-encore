/**
 * The interests a trip can be planned for, as the app shows them.
 *
 * An endpoint rather than a copy in Swift: the list is the *contract*
 * between what somebody ticks and what the scoring can actually match
 * (`interests.ts`). Two copies of it would drift the first time an OSM
 * tag is added to one of them, and the failure would be silent — a
 * choice that quietly matches nothing, which is precisely the bug this
 * vocabulary exists to end.
 */

import { api } from "encore.dev/api";
import { INTERESTS } from "./interests";

export interface InterestOption {
  id: string;
  label: string;
}

export interface InterestsResponse {
  interests: InterestOption[];
}

export const listTripInterests = api(
  { expose: true, method: "GET", path: "/trip-planner/interests", auth: true },
  async (): Promise<InterestsResponse> => ({
    interests: INTERESTS.map((interest) => ({ id: interest.id, label: interest.label })),
  }),
);
