import { Service } from "encore.dev/service";

// Expose API endpoints.
import "./meter";
import "./readings";
import "./import";
import "./api-keys";
import "./ingest";
import "./readings-ocr";
import "./reports";
import "./quick-entry";

export default new Service("meter");
