/**
 * Trip planner service.
 *
 * Turns constraints into a day of blocks filled with spots. The
 * candidate source is the geo service's area search (via osm-admin's
 * client); the arithmetic — budgets, walking estimates, selection and
 * ordering — lives here and is pure.
 *
 * See docs/ios-urlaubsplanung.md for the concept this implements.
 */

import { Service } from "encore.dev/service";

// Side-effect import: registers the endpoints on the service.
import "./plan";
import "./plans";
import "./interpret";
import "./corridor";
import "./food";
import "./visit";
import "./nearby";
import "./add-find";
import "./share";
import "./search";
import "./shares";
import "./pool";

export default new Service("trip-planner");
