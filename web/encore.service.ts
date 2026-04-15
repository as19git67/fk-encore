import { Service } from "encore.dev/service";

// Restrict default permissions for files/dirs the app (and any spawned
// children, e.g. exiftool via exiftool-vendored) create at runtime:
//   files -> 0660 (rw-rw----)
//   dirs  -> 0770 (rwxrwx---)
// This preserves group-write access for ZFS bind-mounted volumes on
// TrueNAS SCALE and replaces the previous shell-level `umask 0007` that
// lived in docker/entrypoint.sh. Setting it here ensures it is applied as
// early as possible in the single Node process that Encore.ts spawns for
// all services.
process.umask(0o007);

// NOTE: The `web` service deliberately does NOT install the maintenance
// middleware because it owns /health and /healthz — monitoring must keep
// working during backups. The raw SPA handler (/app/*) and the typed
// /api/build-info endpoint opt into maintenance mode individually; see
// web/static.ts.
export default new Service("web");

