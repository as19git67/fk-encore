# Adopting Other People's Group Reviews

## The problem

Similar-photo groups (`docs/similar-photo-groups.md`) are **per user**: every
participant of a shared album gets their own `photo_groups` rows and their own
`reviewed_at`. Hiding a photo is per user too (`photo_curation`).

In a four-person household where only one person actually works through the
stacks, that means:

- The reviewer culls a burst down to the one good frame.
- The other three keep seeing all six frames, and their "N groups open"
  counter keeps growing.
- The reviewer's decisions reach the others only as an anonymous
  `hide_count` badge — never as a default.

The manual escape hatch already exists: **"Konsens übernehmen"**
(`acceptPeerConsensusLogic`) applies the peers' decisions to one group on
request. This feature turns that into the default behaviour, per user and
reversible.

## The rule

> If somebody else has already reviewed a group and I have not, their result
> becomes my default. The moment I touch the group myself, it is mine.

Everything else follows from that sentence.

## Model: materialise, but keep the provenance

Two implementations were considered.

**Derive on read** — leave the database alone and compute "effectively hidden
for this user" on every query. Rejected: a user's own hides are consulted in
roughly twenty query sites (album grid, gallery grid, search, slideshow,
recaps, review queue, link visibility, iOS filters). Teaching all of them a
second, derived hide source is a large, risky change for a behavioural default.

**Materialise with provenance** — write real `photo_curation` rows for the
adopting user, marked as adopted rather than self-made. Chosen. Every existing
query keeps working untouched; "adopted" only matters for provenance, for the
UI labels and for undo.

The one thing the naive copy would get wrong — adopted hides inflating the
anonymised `hide_count`, so three passive users would turn one person's opinion
into a fake 4/4 consensus — is solved by the provenance column: the
participant aggregates count `source = 'user'` rows only.

### Schema

| Column | Table | Meaning |
|---|---|---|
| `source` | `photo_curation` | `'user'` (default, self-made) or `'adopted'` (derived from a peer's review) |
| `review_source` | `photo_groups` | `'user'`, `'adopted'`, or NULL while unreviewed |
| `adopt_group_reviews` | `users` | global per-user default, `TRUE` |
| `group_review_adoption` | `album_user_settings` | per album override: NULL = inherit, `'on'`, `'off'` |

No new tables.

### Why `status = 'visible'` rows now exist

`updatePhotoCurationLogic` deletes the curation row when a photo is set back to
visible, because visible is the default. That is no longer enough: after
un-hiding an adopted hide, the next adoption pass would simply hide it again.
So un-hiding an **adopted** row writes a `status = 'visible', source = 'user'`
tombstone instead of deleting. Every consumer already treats
"status is not 'hidden'" as visible, so the tombstone is inert everywhere else.

## Who counts as a reviewer

The privacy boundary is the one `acceptPeerConsensusLogic` and
`listReviewQueueLogic` already use: a peer's decision on a photo counts only
while peer and adopter **currently share at least one album containing that
photo**. Losing the share removes the peer's influence.

The virtual `AI-Rating` user never owns `photo_groups` rows, so it can never be
the source of an adoption. Its votes keep working exactly as before, as one
more anonymous voice in the consensus views.

## When a group counts as reviewed by someone else

For an unreviewed group G of user B, a peer group G_A qualifies when:

- it belongs to a different, non-AI user A,
- `reviewed_at` is set and `review_source = 'user'` (adopted reviews never
  cascade — otherwise one review would ripple through the household and the
  provenance would be a lie),
- and its member set **covers** G: every member of G is also a member of G_A.

Covering rather than exact equality: A may see photos from an album B is not
part of, so A's cluster can be larger. A *smaller* peer cluster does not
qualify — A never looked at the members B has on top, so there is no decision
to adopt.

## What gets hidden

Per member photo of G, over all qualifying peer groups:

| Peer signal | Result |
|---|---|
| at least one peer hid it, none favorited it | hidden, `source = 'adopted'` |
| at least one peer favorited it | kept (a favourite vetoes the hides) |
| no signal at all | kept |

This is deliberately the same conservative rule as "Konsens übernehmen", so the
automatic and the manual path can never disagree.

The group is then marked `reviewed_at = now(), review_source = 'adopted'`.

Two guards:

- An existing `source = 'user'` curation row is never overwritten. B's own
  favourite stays a favourite, B's own visible tombstone stays visible.
- If the rule would leave fewer than two visible members, nothing is written at
  all and the group stays open. Adoption may tidy a stack, never empty it.

## Turning it off

`adopt_group_reviews` on the user is the global default and stands at `TRUE` —
somebody who reviews for themselves never notices adoption, because their own
review always wins.

`album_user_settings.group_review_adoption` overrides it per album. Because
groups are album-independent, the override resolves per group:

1. Collect the albums that contain any member of the group and that the user
   participates in.
2. If any of those albums has an explicit override, use it; `'off'` wins over
   `'on'` when they conflict, since not auto-hiding is the safe side.
3. Otherwise fall back to the user's global default.

Switching a group's governing setting to off **reverts** the adopted rows for
its groups: adopted hides are dropped, `reviewed_at` / `review_source` are
cleared for groups whose review was adopted, and the stacks reappear as open.
User-made rows are untouched.

## Mixed mode falls out of the rule

No per-group flag is needed. "My own action wins" already produces it:

1. B taps the adopted stack. That takes the group back first — the adopted
   hides are dropped and the full stack is on screen — and only then opens the
   compare view. B cannot disagree with a decision he cannot see.
2. Un-hiding an adopted photo anywhere else writes a user tombstone that
   survives later adoption passes.
3. "Fertig" sets `review_source = 'user'`. From then on the group is B's, and
   A's later changes no longer reach it.

So the default is "follow the others", and the exception is per group, reached
by simply doing something.

## Making it visible

Adoption is only acceptable if it is never silent.

- **Grid badge**: adopted stacks get their own badge variant (check mark plus a
  people glyph) instead of the open `+N` counter, so an adopted stack is
  distinguishable from one the user closed themselves.
- **Counters**: "Gruppen bearbeiten (N offen)" and the review queue count
  adopted groups as done; they are not work items any more.
- **Taking a group back**: tapping an adopted badge is "Selbst prüfen". It
  reverts that one group first (`POST /photos/groups/:id/adoption/revert`)
  and only then opens the compare view — reviewing a group whose members you
  cannot see would be worse than not offering it at all. That is also why the
  compare view needs no special case for adopted hides: by the time it opens,
  there are none left.
- **Sidebar** (open): the "Meinungen" block gains a line — "Von jemand
  anderem bereinigt · 2 Fotos ausgeblendet". Anonymous, in line with the
  existing decision not to name who voted.
- **Filter** (open): the hidden-photos filter learns an "übernommen" option,
  so the user can always see what is being filtered away on their behalf.

## When adoption runs

The pass is per user and idempotent, so it can be triggered generously:

| Event | For whom |
|---|---|
| A user marks a group reviewed, accepts an AI pick or a consensus | every peer sharing an album with the affected photos |
| Re-grouping finishes (`scheduleRegroup`) | that user |
| A user switches the setting on | that user |
| Album share added or revoked | the affected participant |

Runs are serialised per user in the same way `scheduleRegroup` serialises
re-grouping, and failures are logged rather than blocking the request.

## Stages

1. **Schema and service** — migration, provenance columns, adoption pass with
   unit tests for the decision rule and integration tests for the pass.
2. **Wiring** — triggers on review/AI-pick/consensus/regroup, participant
   aggregates counting user rows only, settings endpoints.
3. **Frontend** — the adopted badge variant, "Selbst prüfen" on it, and the
   two toggles (global in the profile, per album in the album settings).
4. **Frontend, remaining** — the sidebar line and the filter option above.
5. **iOS** — the app filters album views locally, so it needs the adopted
   flags on the wire before it can show the same thing.

## Affected files

### Backend
- `db/migrations/postgres/0199_group_review_adoption.sql`
- `db/schema.ts` — the four new columns
- `photo/group-review-adoption.ts` — the pure decision rule
- `photo/group-review-adoption.service.ts` — the pass, the setting resolution,
  the revert
- `photo/photo.service.ts` — visible tombstone on un-hiding an adopted row,
  participant aggregates restricted to `source = 'user'`
- `photo/group-auto-pick.service.ts` — adopted groups leave the review queue

### Frontend
- `frontend/src/api/photos.ts`, `frontend/src/api/gallery.ts` —
  `review_source`, the adopted flag, the settings and the revert call
- `frontend/src/components/VirtualGallery.vue` — the adopted badge
- `frontend/src/views/GalleryView.vue`, `frontend/src/views/AlbumDetailView.vue`
  — "Selbst prüfen" and the per-album override
- `frontend/src/views/ProfileView.vue` — the global default
