import { Service } from "encore.dev/service";

// Expose API endpoints.
import "./meter";
import "./readings";

export default new Service("meter");
