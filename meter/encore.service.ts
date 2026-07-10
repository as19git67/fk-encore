import { Service } from "encore.dev/service";

// Expose API endpoints.
import "./meter";
import "./readings";
import "./import";

export default new Service("meter");
