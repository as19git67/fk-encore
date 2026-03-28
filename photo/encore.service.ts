import { Service } from "encore.dev/service";

// Start background scan workers when the service boots.
import "./scan-worker";

// Photo service for managing photos and albums.
export default new Service("photo");
