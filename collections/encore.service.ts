import { Service } from "encore.dev/service";

// Collections of any entity type (issue #1548). The document folder endpoints
// stay in the documents service; this service adds every other type and the
// view across all of them.
export default new Service("collections");
