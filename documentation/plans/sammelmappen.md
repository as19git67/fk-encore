# Collections for every entity type (Sammelmappen)

Issue #1548. The issue holds the full discussion of the open questions with
the alternatives; this plan records what was decided and where the code
stands.

## Goal

One concept for setting things aside and keeping them: a **named collection**
(Sammelmappe) that holds documents, photos, albums, transactions, securities,
meters and single meter readings, with the same UX in every module. The
**basket** stays as the user's one unnamed, mixed collection for what they set
aside while working.

## Decisions

| Question | Decision |
|---|---|
| Typed or mixed | Mixed by default (`entity_type` NULL), typed on request. A typed collection refuses other types. |
| Action menu of a mixed collection | One menu: type-agnostic actions first, then one group per type with the count of items each action affects. |
| Presentation | A typed collection is the module's own list with `collection=<id>` in the query. A mixed one gets one generic `CollectionView`. |
| Many collections | The "Collections" page is a list view (search, sort, filter chips, tiles/table); entries from the module chip, the item's detail page and the basket drawer; recently used, favourites, archive. No folders of folders. |
| Rule-based photo collections | Not called album. Albums stay curated and publishable; "create album from collection" copies the members. |
| Basket | Becomes a collection with `kind = 'basket'`, one per user, mixed, not listed. "Save as collection" names it. |
| Meters | The meter is the member; the export asks for the period. A single reading can be a member as evidence. |
| Exports | Exporters per type, export profiles saved per collection, ZIP of everything, "save as document". |
| Sending | Device share sheet (reaches every messenger) and email via SMTP. No server-side messenger integrations. |
| Share link | Generalises the shared-album links; live or frozen; photo metadata stripped. Needs per-item access checks first. |
| Scheduled export | One daily cron dispatches weekly/monthly/yearly schedules; whole collection or the elapsed period; store or email. |

## Data model (stage 1)

- `document_collections` stays the table of every collection; renaming it
  would touch every document folder query for no behavioural gain. New
  columns: `entity_type` (default `'document'`, NULL = any type),
  `archived_at`, `created_by` (`user` / `assistant`).
- Documents keep `document_collection_items`: their membership carries what
  only a document has in a folder (PDF order, included, pages, redactions).
- Every other type lives in `collection_members(collection_id, entity_type,
  entity_id, joined_by, added_by, added_at)`. No foreign key can point into
  six tables, so `AFTER DELETE` triggers on `photos`, `albums`,
  `finance_transaction`, `finance_depot_security`, `meters` and
  `meter_readings` remove the membership with the row.
- `collection_user_state(collection_id, user_id, favourite, last_opened_at)`:
  the star and the last visit are per reader, because a group collection is
  starred by each member for themselves. Archiving is per collection and
  reserved for whoever may share or delete it.

## Access

- **The collection**: unchanged rule from the document folders
  (`documents/collection-access.ts`): a private collection is its creator's,
  a group collection belongs to the group, `data.manage` reads all; sharing,
  archiving and deleting are for the creator, a group owner or an admin.
- **Each member**: decided by its own module (`collections/members.ts`):
  documents and meters by owner or group, photos and albums by ownership and
  album shares, transactions and securities by the account ACL
  (`finance/account-acl.ts`). A type is invisible without its module
  permission. Members a reader may not open are left out and counted in
  `hidden_count`; in a group collection two readers can therefore see
  different members.
- Documents in a group folder must still be shared with the group
  (`assertMembersFitVisibility`); the other types have no group concept, so
  per-reader hiding is the only rule for them.

## API (stage 1)

Service `collections`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/collections` | List with `q`, `type` (a type or `mixed`), `holds`, `archived`, `favourite`, `created_by`, `sort` (`last_opened`, `updated`, `name`, `count`), `dir` |
| POST | `/collections` | Create, optionally typed and with first members |
| GET | `/collections/:id` | Detail with the members the caller may see |
| PATCH | `/collections/:id` | Name, description, archive, own star |
| DELETE | `/collections/:id` | Delete (administrators) |
| POST | `/collections/:id/opened` | Remember the visit |
| POST | `/collections/:id/members` | Add members of any type; one bad reference refuses the batch |
| DELETE | `/collections/:id/members/:entityType/:entityId` | Take one member out |
| GET | `/collections/of/:entityType/:entityId` | The collections holding an item |

Documents added or removed here go through the same functions as the
document folder endpoints (`documents/collection-membership.ts`), so dossier
exclusions, PDF order and summary invalidation behave the same. The document
folder list (`/document-collections`) shows only document and mixed
collections.

## Stages

1. **Backend: generic collections** — done in this stage's PR.
2. One basket store and drawer across modules; "add to collection" from every
   list and detail page; "In collections" panel on detail pages. Migrate the
   finance basket snapshots (`finance_basket_snapshot`, named saved baskets
   with compare) into transaction collections.
3. Typed collection = module list with `collection` filter; global
   "Collections" page.
4. Mixed `CollectionView` with grouped action menu.
5. Rules for photos, transactions, securities and meters; "create album from
   collection".
6. Exporters per type and export profiles; ZIP; "save as document".
7. Sending: share sheet in web and iOS, email via SMTP.
8. Anonymous share links (after per-item access checks).
9. Scheduled exports.

## Facts found while starting

- There is no photo basket today; only finance and documents have one, and
  both live in `sessionStorage` (per browser tab).
- Finance already has named, saved baskets with a compare view
  (`finance/basket.ts`, `finance_basket_snapshot`); they are transaction
  collections in all but name and move over in stage 2.
