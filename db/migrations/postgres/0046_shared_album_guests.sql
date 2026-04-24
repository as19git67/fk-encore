-- Migration 0043: Gast-Zugang für geteilte Alben.
--
-- Empfänger eines öffentlichen Album-Links können ohne Account
-- kommentieren und Benachrichtigungen abonnieren (Mail-Digest + Web
-- Push). Identifikation ist global per E-Mail, damit derselbe Empfänger
-- über mehrere Links / Alben wiedererkannt wird.
--
-- Delivery-Modell: fan-out-on-write in guest_notifications, analog zu
-- feed_items. Der Digest-Cron aggregiert pro Gast und setzt
-- delivered_at; Web Push ist best-effort und unabhängig.

CREATE TABLE guests (
    id                SERIAL      PRIMARY KEY,
    email             TEXT        NOT NULL UNIQUE,
    display_name      TEXT        NOT NULL,
    -- Zufalls-Token für Magic-Link beim Erst-Login. Wird nach
    -- erfolgreicher Verifikation auf NULL gesetzt.
    verify_token      TEXT        UNIQUE,
    verified_at       TIMESTAMPTZ,
    -- Stabiler Token für One-Click-Unsubscribe in jeder Digest-Mail.
    unsubscribe_token TEXT        NOT NULL UNIQUE,
    notify_opt_in     BOOLEAN     NOT NULL DEFAULT TRUE,
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- Welche Public-Links ein Gast schon benutzt hat. Wird beim ersten
-- Landing gesetzt und bei jedem Besuch aktualisiert. Fan-out-Query
-- joint hierüber album_public_links → albums.
CREATE TABLE guest_link_access (
    guest_id        INTEGER     NOT NULL REFERENCES guests(id)              ON DELETE CASCADE,
    public_link_id  INTEGER     NOT NULL REFERENCES album_public_links(id)  ON DELETE CASCADE,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guest_id, public_link_id)
);--> statement-breakpoint

-- Reverse-Lookup: "alle Gäste, die Link X benutzt haben".
CREATE INDEX idx_guest_link_access_link
    ON guest_link_access (public_link_id);--> statement-breakpoint

-- Cookie-backed Gast-Session. `id` ist der Opaque-Token im HttpOnly-
-- Cookie. `public_link_id` merkt sich, über welchen Link die Session
-- begonnen hat (für Attribution und als Fallback bei Link-Rotation).
CREATE TABLE guest_sessions (
    id              TEXT        PRIMARY KEY,
    guest_id        INTEGER     NOT NULL REFERENCES guests(id)              ON DELETE CASCADE,
    public_link_id  INTEGER     NOT NULL REFERENCES album_public_links(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL
);--> statement-breakpoint

CREATE INDEX idx_guest_sessions_guest
    ON guest_sessions (guest_id);--> statement-breakpoint

-- Web Push Subscriptions für Gäste. Dedup über endpoint (wie bei
-- push_subscriptions für eingeloggte User).
CREATE TABLE guest_push_subscriptions (
    id            BIGSERIAL   PRIMARY KEY,
    guest_id      INTEGER     NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    endpoint      TEXT        NOT NULL UNIQUE,
    p256dh        TEXT        NOT NULL,
    auth          TEXT        NOT NULL,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ
);--> statement-breakpoint

CREATE INDEX idx_guest_push_subscriptions_guest
    ON guest_push_subscriptions (guest_id);--> statement-breakpoint

-- Pending-Queue für Gast-Benachrichtigungen. Fan-out-on-write:
-- eine Zeile pro (Gast, Event). Der Digest-Cron aggregiert und setzt
-- delivered_at auf den Zeitpunkt des Mail-Versands.
CREATE TABLE guest_notifications (
    id            BIGSERIAL   PRIMARY KEY,
    guest_id      INTEGER     NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    album_id      INTEGER     NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    -- 'photo_added' | 'comment_added'
    kind          TEXT        NOT NULL,
    payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at  TIMESTAMPTZ
);--> statement-breakpoint

-- Hot path: "alle undelivered Events für Gast X, chronologisch".
-- Partial-Index, damit er nach Digest-Lauf klein bleibt.
CREATE INDEX idx_guest_notifications_pending
    ON guest_notifications (guest_id, created_at)
    WHERE delivered_at IS NULL;--> statement-breakpoint

-- photo_comments: Autor darf auch ein Gast sein. user_id wird
-- nullable, guest_id kommt dazu; CHECK stellt sicher, dass genau
-- eines von beiden gesetzt ist.
ALTER TABLE photo_comments
    ALTER COLUMN user_id DROP NOT NULL;--> statement-breakpoint

ALTER TABLE photo_comments
    ADD COLUMN guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE photo_comments
    ADD CONSTRAINT photo_comments_author_chk CHECK (
        (user_id IS NOT NULL AND guest_id IS NULL)
     OR (user_id IS NULL     AND guest_id IS NOT NULL)
    );--> statement-breakpoint

-- Listing für Gast-Kommentare (z.B. Moderation, Reverse-Lookup).
CREATE INDEX idx_photo_comments_guest
    ON photo_comments (guest_id)
    WHERE guest_id IS NOT NULL;
