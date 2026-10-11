-- Rectangles blacked out on a member's pages when the Sammelmappe's PDF is
-- built: [{ "page": 1, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05 }, …], each
-- relative to the visible page (0..1, origin top left). A redacted page is
-- re-rendered as an image with the boxes burnt in, so nothing under them
-- survives in the output. The document itself stays untouched.
ALTER TABLE "document_collection_items"
  ADD COLUMN "redactions" jsonb NOT NULL DEFAULT '[]'::jsonb;
