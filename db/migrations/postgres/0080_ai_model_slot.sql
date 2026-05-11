CREATE TABLE ai_model_slot (
    id          BIGSERIAL PRIMARY KEY,
    model_name  TEXT NOT NULL,
    priority    INT NOT NULL DEFAULT 2,
    requester   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'waiting',
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ
);

CREATE INDEX idx_model_slot_dequeue
    ON ai_model_slot (model_name, status, priority, enqueued_at);
