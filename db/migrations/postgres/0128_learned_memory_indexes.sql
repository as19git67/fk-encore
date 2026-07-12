-- Migration 0128: Indexes for loadLearnedMemory (documents/learned-rules.ts).
--
-- loadLearnedMemory runs four unbounded queries per classify call, each
-- joining through the documents table filtered by user_id + a review flag +
-- sender IS NOT NULL.  Without covering indexes these degrade to sequential
-- scans as the reviewed-document count grows.
--
-- 1) Categories query: documents WHERE user_id=? AND attributes_reviewed AND sender IS NOT NULL
-- 2) Tax sections query: documents WHERE user_id=? AND tax_reviewed AND sender IS NOT NULL
-- 3) Tags query: document_tag_links WHERE source='user' (joined via document_id)
-- 4) Subject persons query: document_subject_persons WHERE source='user' (joined via document_id)

CREATE INDEX idx_documents_learned_category
  ON documents (user_id, category_id)
  WHERE attributes_reviewed = true AND sender IS NOT NULL;--> statement-breakpoint

CREATE INDEX idx_documents_learned_tax
  ON documents (user_id)
  WHERE tax_reviewed = true AND sender IS NOT NULL;--> statement-breakpoint

CREATE INDEX idx_document_tag_links_learned
  ON document_tag_links (document_id, tag_id)
  WHERE source = 'user';--> statement-breakpoint

CREATE INDEX idx_document_subject_persons_learned
  ON document_subject_persons (document_id, subject_person_id)
  WHERE source = 'user';
