-- Admin-editable overrides for the per-section `hint` string that is sent
-- to the LLM in the /classify prompt (see documents/tax-sections.ts).
--
-- Slug/name/group remain hardcoded as the canonical set — only the hint
-- can be tuned at runtime so users can improve classification without a
-- deploy. A missing row means "use the default from tax-sections.ts".

CREATE TABLE IF NOT EXISTS tax_section_hint_overrides (
  slug TEXT PRIMARY KEY,
  hint TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
