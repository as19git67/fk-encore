-- Migration 0037: Realtime event outbox.
--
-- Every event dispatched by realtime.publishEvent is persisted here
-- before being forwarded to the PubSub topic. Clients that reconnect
-- pass the last `seq` they processed via the WebSocket handshake
-- (`lastEventId` query parameter) and the server replays every row
-- stored for that user with a greater `seq`.
--
-- Retention: realtime/retention-cron.ts prunes rows older than 7 days.

CREATE TABLE realtime_events (
  id          TEXT        PRIMARY KEY,
  seq         BIGSERIAL   NOT NULL UNIQUE,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  resource_id TEXT        NOT NULL,
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  version     INTEGER     NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- Hot path: resume query scans forward by seq for a single user.
CREATE INDEX idx_realtime_events_user_seq
  ON realtime_events (user_id, seq);--> statement-breakpoint

-- Retention sweep: bounds the DELETE to a range scan on created_at.
CREATE INDEX idx_realtime_events_created_at
  ON realtime_events (created_at);
