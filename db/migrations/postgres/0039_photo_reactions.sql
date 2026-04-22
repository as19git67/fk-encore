-- Photo reactions: likes + comments.
--
-- Audience is determined at API time (everyone with access to the
-- photo), so nothing photo-access-related is encoded in the schema.

CREATE TABLE photo_likes (
    photo_id   INTEGER     NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    user_id    INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (photo_id, user_id)
);

-- Reverse lookup: "photos liked by user X" (rare, but cheap to keep).
CREATE INDEX idx_photo_likes_user ON photo_likes (user_id, created_at DESC);

CREATE TABLE photo_comments (
    id         BIGSERIAL   PRIMARY KEY,
    photo_id   INTEGER     NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    user_id    INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at  TIMESTAMPTZ
);

-- Listing comments for a photo in chronological order.
CREATE INDEX idx_photo_comments_photo_created
    ON photo_comments (photo_id, created_at ASC, id ASC);
