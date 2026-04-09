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

export default new Service("web");

