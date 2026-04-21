-- Web Push subscriptions: one row per browser that opted in.
-- Endpoint is the natural dedup key (browsers return the same URL on
-- repeat subscribe calls), so we index it UNIQUE.

CREATE TABLE push_subscriptions (
    id            BIGSERIAL   PRIMARY KEY,
    user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint      TEXT        NOT NULL UNIQUE,
    p256dh        TEXT        NOT NULL,
    auth          TEXT        NOT NULL,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ
);

-- Fan-out query: "all subscriptions for user X".
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);
