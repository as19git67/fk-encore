import { Service } from "encore.dev/service";
// The assistant calls llm-service's /chat; this adds the internal bearer token.
import "../lib/internal-service-auth";

console.log("[boot] assistant/encore.service.ts: begin");

// Side-effect import registers the conversation, ask and stream endpoints.
import "./assistant";
// Side-effect import registers the benchmark endpoints.
import "./benchmark";

console.log("[boot] assistant/encore.service.ts: registering Service");
export default new Service("assistant");
console.log("[boot] assistant/encore.service.ts: end");
