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

1. **Backend: generic collections** — done (#1557).
2. **Shared basket, "add to collection" everywhere** — done (#1558):
   - The basket is a collection with `kind = 'basket'` (migration 0243, one
     per user by a partial unique index), with endpoints under
     `/collections/basket` (get, add, remove, empty by type, save as
     collection). It never appears in folder lists, document badges, the
     "in a collection" filter, the reverse lookup or the summary job.
   - Saved finance baskets were copied into private transaction collections
     (migration 0243; the old table stays untouched as a backup). The finance
     snapshot endpoints now read and write those collections, so the drawer's
     "load/save/compare" and the collections see the same folders.
   - Frontend: `stores/basket.ts` holds the shared basket (optimistic, writes
     batched). The transaction and document stores keep their whole objects
     and mirror the basket (`composables/useBasketMirror.ts`): their changes
     go to the server, and what arrives or leaves elsewhere is fetched or
     dropped. A tab's old sessionStorage pile is handed over once.
   - Modules without a drawer of their own (photos, meters, …) show
     `SharedBasketIndicator`; the document and finance drawers say what else
     lies in the basket and can save the whole pile (`BasketOthers`).
   - "In den Basket" and "In Sammelmappe legen" in the gallery and album
     selection bars, the transaction list selection, the album page, the
     photo sidebar, the meter page and its readings, and the security rows of
     a position. Non-document detail pages carried `InCollectionsCard`;
     documents kept their own card with dossier details (both replaced in
     stage 5, see "Ablegen").
3. **Typed collection = module list; the "Collections" page** — done (#1559):
   - `collection` filter in the module lists: the gallery (`collectionId`
     in the photo filter, `?collection=` in the URL, picker in the filter
     menu), albums (client-side, from the collection's members), the
     transaction list (`collectionId`; a new route
     `/finanzen/sammelmappe/:collectionId` lists a transaction collection
     across every readable account), meters (`?collection=`, scope bar).
     Documents already had it. Backend: `collections/scope.ts` builds the
     condition and checks in SQL that the caller may read the collection,
     so a foreign folder yields an empty list.
   - `utils/collectionRoute.ts` decides where a collection opens: a typed
     one in its module list, document folders and dossiers on their folder
     page, everything else on `/sammelmappen/:id`.
   - `/sammelmappen` (navbar folder button): `ListToolbar` with search,
     filters for type, archive, favourites and creator, sort by last visit,
     change, name or size, tiles or table; starred first; rename, archive,
     delete per row; "Neue Sammelmappe" with a type.
   - `/sammelmappen/:id` for mixed collections, securities and readings:
     members grouped by type, each group with "Als Liste öffnen", search,
     type filter, sort, remove, hidden members counted.
   - The chips of `InCollectionsCard` link to the collection.
4. **Grouped action menu for mixed collections** — done (#1560):
   - `/sammelmappen/:id` has a selection mode (`useListSelection`, the
     usual `SelectionBar`; a member is keyed by one number that encodes
     type and id, `utils/collectionActions.ts`).
   - One menu (`groupedSelectionActions`): "Herausnehmen", "In
     Sammelmappe", "In den Basket" first, then each type's batch actions
     with type and count in the label ("Buchungen (3): Als geprüft
     markieren"); with one type selected the prefix goes away.
   - Type actions: documents (reviewed, tax-relevant), transactions
     (reviewed, tax-relevant, CSV), photos (favourite, add to albums).
     Actions that need a module's own dialog with whole objects (tags,
     batch attributes with tristate) stay in that module's list, reachable
     through "Als Liste öffnen".
5. **Rules for photos, transactions, securities and meters; album from a
   collection** — done:
   - A rule collection has `kind = 'rule'`, is typed for the rule's kind and
     stores the rule in `rule` (`collections/rules.ts`): photos keep a
     gallery filter (the gallery's URL form, typed by `coercePhotoFilter`),
     transactions keep the list's criteria (accounts, text, tags, dates,
     tax-relevant), securities depots and statuses (confirmed by default),
     meters types and a location text.
   - Rules run as the collection's owner, on create, on change, on demand
     ("Regel jetzt anwenden") and every hour (`collections/rules-cron.ts`).
     What the rule added it takes away again; a member taken out by hand is
     remembered in `excluded_ids`. "Regel beenden" keeps the members as
     hand-picked ones.
   - Making one: "Als Regel-Mappe" in the gallery and the transaction list
     saves the current filter; the new-collection dialog offers a rule for
     meters (types, location) and securities (depots).
   - "Album daraus erstellen" copies the photos a reader can see into a new
     album (needs `albums.manage`); the collection stays as it is.
   - Also in this stage: the albums overview got a selection mode with "In
     den Basket" and "In Sammelmappe"; the album page hides its own "Album
     in den Basket / in Sammelmappe" while photos are being picked.
   - **Filing in one place ("Ablegen")**, after feedback on stages 1–5:
     one button and one dialog for the basket and the collections instead
     of two side by side (`components/collections/FileButton.vue`,
     `AddToCollectionDialog.vue`). The dialog puts the basket first, lists
     the fitting collections and makes a new one (for documents optionally
     as a dossier). For a single item it ticks where the item already lies,
     and a click takes it out again. Every detail page has the button at
     the top next to its other actions (photo sidebar, document page and
     document preview, transaction, meter, album); every selection bar has
     one "Ablegen" action; rows that had a basket toggle (documents,
     readings, depot rows, meter tiles) open the same dialog. Icon:
     `pi-folder-plus`, `pi-folder-open` while the item lies in the basket.
     The "Sammelmappen" cards on detail pages are gone: where an item lies
     is shown in the dialog, and every collection is reachable from the
     navbar.
   - **One basket drawer**: every module shows the whole shared basket,
     grouped by type with the same headers
     (`components/collections/BasketMemberList.vue`), and ends with the same
     footer, "Leeren" and "Als Sammelmappe speichern" (`BasketFooter.vue`).
     The badge counts every item. Documents and finance draw their own rows
     in more detail through the slot `rows-<type>`, put their group first
     and keep their batch actions above the footer, labelled for their kind.
6. **Exporters per type and export profiles; ZIP; "save as document"** — done:
   - Options per type in one object (`collections/export-options.ts`):
     documents as one PDF (the folder's page selection and redactions apply,
     `buildCollectionPdf`) or a ZIP of the originals (switched-off and
     redacted documents stay out); transactions as PDF, Excel or CSV with a
     column picker, grouping by account in a chosen order and sums per
     account and in total — the PDF says it is a selection, not a bank
     statement, so it shows no opening or closing balance; photos and albums
     (a folder per album) as originals or 2560 px JPEGs, metadata stripped on
     request by re-encoding; securities with the bank's latest holding and
     the cached quote; meters with their readings in a period and the
     consumption between two readings of the same device, single readings
     in a section of their own.
   - One kind that fits one file is the export itself; anything else is a
     ZIP with a folder per kind plus `Inhalt.pdf` and `Inhalt.csv`, which
     list every item and say why one is missing (`collections/exporters.ts`,
     tables in `export-tables.ts`).
   - Runs happen in the background per reader (`collection_exports`,
     migration 0244), files on disk for a week, the last five runs per reader
     kept; the hourly collections job removes expired files. A PDF can be
     filed into the documents module ("Als Dokument ablegen").
   - Profiles: named options per collection (`collection_export_profiles`),
     overwritten by name; stages 7–9 reuse them.
   - Frontend: `components/collections/ExportDialog.vue` on the collection
     page, in the row menu of the collections list and in every basket
     drawer's footer.
   - Not yet: a push when a long export is ready (the dialog polls), the
     document folder page keeps its own PDF builder with cover and summary.
7. Sending: share sheet in web and iOS, email via SMTP.
8. Anonymous share links (after per-item access checks).
9. Scheduled exports.

## Facts found while starting

- There is no photo basket today; only finance and documents have one, and
  both live in `sessionStorage` (per browser tab).
- Finance already had named, saved baskets with a compare view
  (`finance/basket.ts`, `finance_basket_snapshot`); they moved over in
  stage 2.
