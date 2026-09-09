-- Fine-grained operations instead of one overwritten plan (§6.3).
--
-- Several devices, some of them offline, change the same trip. §6.3
-- calls this the most expensive part of multi-user and gives it one
-- clear decision: **the plan is never written as a whole.** What gets
-- written are small operations — hide a spot, cast a vote, put a stop
-- back in the pool, write a note — which the server merges. Whoever
-- saves the whole plan as a document loses the others' changes,
-- reliably.
--
-- The endpoints have worked that way from the start. What was missing
-- is this table, and it exists for the two things §6.3 asks for beyond
-- the granularity:
--
--   * **Operations made offline are buffered and applied on connect.**
--     A buffered batch may be sent twice — the connection that dropped
--     mid-request is exactly the case this is for — so each operation
--     carries an id minted on the device, and the second arrival is
--     recognised rather than applied again.
--   * **Who changed what stays visible, with an undo.** `previous`
--     holds the state the operation replaced, where there is one, so
--     an undo is a real inverse rather than a guess. Operations
--     without an exact inverse say so rather than pretending.
--
-- Undoing writes a *new* row rather than deleting one: the journal is
-- what happened, and rewriting it would lose the very information it
-- exists to keep.
CREATE TABLE IF NOT EXISTS trip_plan_ops (
  id serial PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  -- Minted on the device, so a replayed batch is recognised. Unique
  -- per plan rather than globally: two devices generating the same
  -- uuid for different trips is not this table's problem to solve.
  client_op_id text NOT NULL,
  -- hide-spot | unhide-spot | vote | spot-note | stop-to-pool.
  -- Validated in trip-planner/ops.ts; a new operation should not need
  -- a migration.
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What this operation replaced, when it replaced something. NULL
  -- means "no exact inverse" — an undo then says so.
  previous jsonb,
  actor_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set when a later operation undid this one, and by whom.
  undone_at timestamptz,
  undone_by integer REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_ops_plan_client_key
  ON trip_plan_ops (plan_id, client_op_id);
CREATE INDEX IF NOT EXISTS trip_plan_ops_plan_idx
  ON trip_plan_ops (plan_id, created_at DESC);
