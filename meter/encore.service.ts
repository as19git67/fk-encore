import { Service } from "encore.dev/service";
// Side-effect: attaches the shared secret to every outbound call to the
// internal Python services. See lib/internal-service-auth.ts.
import "../lib/internal-service-auth";

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
