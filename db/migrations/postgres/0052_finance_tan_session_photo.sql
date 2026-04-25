-- photoTAN / Flicker-TAN persistence on the TAN-session row.
--
-- lib-fints surfaces a `tanPhoto: { mimeType, image: Uint8Array }`
-- on the bank's response for photoTAN methods (comdirect's
-- "PhotoTAN", various Volksbanken Flicker codes, …). We base64-encode
-- the bytes for JSON transport to the UI, but also persist them on
-- the tan_session row so a page reload doesn't strand the dialog —
-- the user typically needs a moment to scan the matrix on a separate
-- device.
--
-- tan_media_name was previously surfaced via JSON in the response
-- only; persisting it lets the resume path quote the same media on
-- a subsequent challenge.

ALTER TABLE finance_tan_session
    ADD COLUMN IF NOT EXISTS tan_photo_mime TEXT,
    ADD COLUMN IF NOT EXISTS tan_photo_base64 TEXT,
    ADD COLUMN IF NOT EXISTS tan_media_name TEXT;
