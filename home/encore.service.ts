import { Service } from "encore.dev/service";

// Expose API endpoints.
import "./systems";

// The house module (Haus): a handbook of the house's technical systems —
// guides, items in place, notes (documentation/plans/haus-anlagen.md).
// The meters stay their own module (meter/) and are linked from here.
export default new Service("home");
