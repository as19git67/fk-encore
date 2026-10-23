/**
 * The roles and permissions the seed converges every database to. Plain data
 * without imports, so the frontend can test its menus and routes against the
 * same role definitions (`frontend/src/config/moduleRoles.test.ts`).
 */

export const defaultRoles = [
  { name: "Admin", description: "Full administrative access" },
  { name: "User", description: "Basic user access (login, profile)" },
  { name: "Photo User", description: "Access to the photos module" },
  { name: "Dokumente User", description: "Access to the documents module" },
  { name: "Finance User", description: "Access to the finance module" },
  { name: "Label User", description: "Access to the label printing module" },
  { name: "Zähler User", description: "Access to the utility meters module" },
  { name: "Assistent User", description: "Access to the assistant chat" },
];

export const allPermissions = [
  { key: "users.list", description: "View user list" },
  { key: "users.read", description: "View user details" },
  { key: "users.create", description: "Create new users" },
  { key: "users.update", description: "Update existing users — can set any non-administrator's password, so it is a takeover of those accounts. Administrators can only be changed by an administrator." },
  { key: "users.delete", description: "Delete users" },
  { key: "roles.list", description: "View role list" },
  { key: "roles.read", description: "View role details" },
  { key: "roles.create", description: "Create new roles" },
  { key: "roles.update", description: "Update existing roles — ⚠ equals full admin: the holder can attach any permission to a role they already hold. Grant only to someone you would make an administrator." },
  { key: "roles.delete", description: "Delete roles" },
  { key: "roles.assign", description: "Assign roles to users — any role except Admin, which only an administrator may hand out." },
  { key: "roles.revoke", description: "Revoke roles from users" },
  { key: "module.photos", description: "Enable photos module" },
  { key: "photos.upload", description: "Upload photos" },
  { key: "photos.view", description: "View photos" },
  { key: "photos.delete", description: "Delete photos" },
  { key: "photos.refresh_metadata", description: "Refresh photos metadata (EXIF)" },
  { key: "albums.manage", description: "Manage albums" },
  { key: "people.view", description: "View people and faces" },
  { key: "people.edit", description: "Edit people names and merge" },
  { key: "data.manage", description: "Access data management (reindex, maintenance)" },
  { key: "photos.purge", description: "Purge all photo-related data (destructive)" },
  { key: "photos.libraries.manage", description: "Configure external photo libraries" },
  // --- Documents module ---
  { key: "module.documents", description: "Enable documents module" },
  { key: "documents.view", description: "View documents" },
  { key: "documents.upload", description: "Upload documents" },
  { key: "documents.edit", description: "Edit document metadata and reclassify" },
  { key: "documents.delete", description: "Delete documents" },
  { key: "documents.manage_taxonomy", description: "Manage document categories and AI suggestions" },
  { key: "groups.view", description: "View groups the user belongs to" },
  { key: "groups.manage", description: "Create and edit groups, manage members" },
  // --- Finance module ---
  { key: "module.finance", description: "Enable finance module" },
  { key: "finance.view", description: "View accounts and transactions (ACL-filtered)" },
  { key: "finance.accounts.manage", description: "Manage bank contacts and accounts" },
  { key: "finance.admin", description: "Finance admin (ACL bypass, data import)" },
  // --- POI detection / OSM admin (Epic #383) ---
  { key: "osm.admin", description: "Manage self-hosted PostGIS region imports for reverse geocoding + POI lookup" },
  // --- Label module ---
  { key: "module.label", description: "Enable label printing module" },
  { key: "label.view", description: "View label module and select a printer" },
  { key: "label.print", description: "Print labels to a CUPS printer" },
  // --- Utility meters module (Issue #792) ---
  { key: "module.meters", description: "Enable utility meters module" },
  { key: "meters.view", description: "View meters, readings and reports" },
  { key: "meters.read_entry", description: "Enter meter readings (manual/OCR)" },
  { key: "meters.manage", description: "Create/edit/replace meters and manage API keys" },
  // --- Assistant (documentation/plans/ki-assistent.md, #1528) ---
  { key: "module.assistant", description: "Enable the assistant chat" },
];

// Permissions that are NEVER auto-assigned to the Admin role.
// These must be granted manually to a dedicated role for safety.
//   - photos.purge wipes the photo library (destructive).
//   - finance.admin bypasses the finance_account_access ACL.
export const adminExcludedPermissions = new Set<string>([
  "photos.purge",
  "finance.admin",
]);

export const rolePermissionsMap: Record<string, string[]> = {
  User: ["users.read"],
  "Photo User": [
    "module.photos",
    "photos.view",
    "photos.upload",
    "photos.delete",
    "people.view",
    "people.edit",
  ],
  "Dokumente User": [
    "module.documents",
    "documents.view",
    "documents.upload",
    "documents.edit",
    "documents.delete",
    "groups.view",
    "groups.manage",
  ],
  "Finance User": [
    "module.finance",
    "finance.view",
    "finance.accounts.manage",
  ],
  "Label User": [
    "module.label",
    "label.view",
    "label.print",
  ],
  "Zähler User": [
    "module.meters",
    "meters.view",
    "meters.read_entry",
  ],
  // The assistant is granted on its own (#1648): a module role no longer
  // brings it along, so an admin can give someone a module without the chat
  // or take the chat away without the module.
  "Assistent User": ["module.assistant"],
};
