import { Service } from "encore.dev/service";

// Start the background scan worker as a side-effect of loading this module.
import "./scan-worker";

export default new Service("documents");
