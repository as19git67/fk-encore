-- Sammelmappen: several documents gathered under one title, and the single
-- PDF that comes out of them.
--
-- A folder of paper is what people actually hand over — to a Steuerberater,
-- an insurer, a landlord. Until now the only way to produce one from here was
-- to download the documents one at a time and let the recipient sort them,
-- which loses the two things that made it a folder: the order they belong in,
-- and the covering note that says what they are.
--
-- A document belongs to as many collections as it likes. The membership row
-- carries everything that is true of *this* document *in this* folder — where
-- it sits, whether it is currently switched on, and which of its pages are
-- left out — and nothing about the document itself. Removing a document from
-- a collection therefore never touches the document, and the same document in
-- two collections can be trimmed differently in each.
CREATE TABLE IF NOT EXISTS document_collections (
  id serial PRIMARY KEY,
  -- Creator. Stays put when the collection is later shared into a group,
  -- exactly as `documents.user_id` does.
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- Free-form covering note, printed under the title on the cover page.
  notes text,
  -- Summary written across the member documents by the llm-service. Kept
  -- beside `summary_stale`: every change to the membership invalidates it and
  -- the background job rewrites it, so the text on the cover is never a
  -- summary of a folder that no longer exists.
  summary text,
  summary_generated_at timestamptz,
  summary_stale boolean NOT NULL DEFAULT true,
  -- Last failure from the summary job, cleared on the next success. Without
  -- it a permanently unreachable llm-service looks identical to a collection
  -- nobody has summarised yet.
  summary_error text,
  -- Which parts the generated PDF carries. All three default on; a folder of
  -- two documents rarely wants a table of contents, and switching it off must
  -- not mean losing the entries.
  include_cover boolean NOT NULL DEFAULT true,
  include_toc boolean NOT NULL DEFAULT true,
  include_summary boolean NOT NULL DEFAULT true,
  -- Same access model as `documents`: private to the creator, or shared with
  -- one group. The member documents keep their own visibility — a collection
  -- never widens access to what is inside it.
  visibility document_visibility NOT NULL DEFAULT 'private',
  group_id integer REFERENCES groups(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_collections_group_visibility CHECK (
    (visibility = 'group' AND group_id IS NOT NULL)
    OR (visibility = 'private' AND group_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS document_collections_user_idx
  ON document_collections (user_id);
CREATE INDEX IF NOT EXISTS document_collections_group_idx
  ON document_collections (group_id);
-- The summary job's work queue: the stale rows, oldest first.
CREATE INDEX IF NOT EXISTS document_collections_stale_idx
  ON document_collections (summary_stale, updated_at);

CREATE TABLE IF NOT EXISTS document_collection_items (
  id serial PRIMARY KEY,
  collection_id integer NOT NULL
    REFERENCES document_collections(id) ON DELETE CASCADE,
  document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Sort key within the collection. Dense and 0-based after every reorder;
  -- the service layer renumbers rather than leaving gaps, so "position + 1"
  -- is the number printed in the table of contents.
  position integer NOT NULL,
  -- Switched off means: still in the folder, not in the PDF. Deselecting a
  -- document must not throw away the page selection made for it, which
  -- deleting the row would.
  included boolean NOT NULL DEFAULT true,
  -- 1-based page numbers of this document left out of the PDF, ascending and
  -- deduplicated. `[]` means the whole document. Stored per membership, not
  -- per document: the same statement can be whole in one folder and reduced
  -- to its last page in another.
  excluded_pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_collection_items_unique_idx
  ON document_collection_items (collection_id, document_id);
CREATE INDEX IF NOT EXISTS document_collection_items_order_idx
  ON document_collection_items (collection_id, position);
-- "Which folders is this document in?" — shown on the document detail.
CREATE INDEX IF NOT EXISTS document_collection_items_document_idx
  ON document_collection_items (document_id);
