-- Migration 0100: Track the origin of each document↔tag link.
--
-- Re-classify (runClassify → replaceTagLinks) used to DELETE every tag link of
-- a document and re-insert only the AI-suggested tags, wiping any tag a human
-- had added by hand. Mark each link with its source so the AI path replaces
-- only its own ('ai') rows and leaves user-curated ('user') tags untouched.
--
-- Existing rows default to 'ai': historically all links came from the
-- classifier, and the few manual ones cannot be told apart retroactively.
-- From here on, the manual edit paths (PATCH /documents/:id, POST
-- /documents/batch/tags) write source='user'.

ALTER TABLE document_tag_links
  ADD COLUMN source TEXT NOT NULL DEFAULT 'ai';
