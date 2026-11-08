import { Service } from "encore.dev/service";

// Expose API endpoints.
import "./label";
import "./scanner";

export default new Service("label");
