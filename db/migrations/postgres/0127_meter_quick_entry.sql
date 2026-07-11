-- Migration 0127: per-user quick-entry meter list.

CREATE TABLE meter_quick_entry_items (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meter_id INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, meter_id)
);

CREATE INDEX meter_quick_entry_items_user_order_idx
  ON meter_quick_entry_items(user_id, sort_order);
