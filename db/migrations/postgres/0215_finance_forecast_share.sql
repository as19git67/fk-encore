-- Retirement forecast: one forecast per household, shared instead of kept twice.
--
-- The owner of a forecast shares it with a person or with a group (the
-- groups the documents module uses). Whoever it is shared with and has no
-- forecast of their own opens the owner's forecast directly: the same
-- persons, items, scenarios and statements, editable with level 'edit',
-- read-only with 'view'. The data keeps its owner (user_id), so ending a
-- share loses nothing.

CREATE TABLE finance_forecast_share (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  target_group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'edit',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finance_forecast_share_level_check CHECK (level IN ('edit', 'view')),
  CONSTRAINT finance_forecast_share_one_target CHECK ((target_user_id IS NULL) <> (target_group_id IS NULL)),
  CONSTRAINT finance_forecast_share_not_self CHECK (target_user_id IS NULL OR target_user_id <> owner_user_id)
);

CREATE UNIQUE INDEX finance_forecast_share_user_unique ON finance_forecast_share (owner_user_id, target_user_id) WHERE target_user_id IS NOT NULL;
CREATE UNIQUE INDEX finance_forecast_share_group_unique ON finance_forecast_share (owner_user_id, target_group_id) WHERE target_group_id IS NOT NULL;
CREATE INDEX idx_finance_forecast_share_target_user ON finance_forecast_share (target_user_id);
CREATE INDEX idx_finance_forecast_share_target_group ON finance_forecast_share (target_group_id);
