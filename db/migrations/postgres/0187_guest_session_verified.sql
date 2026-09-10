-- Verification belongs to the session, not to the guest.
--
-- register() recognizes a returning guest by email and reuses their row,
-- then hands out a session cookie for that guest id immediately — before
-- the magic-link mail has been opened. The write gates (comments, push)
-- checked guests.verified_at, which is a property of the person and was
-- set the first time they verified, possibly years ago on another device.
--
-- So anyone holding a share link who knew another guest's address could
-- register with it and inherit that identity: comment under their name,
-- and edit or delete their existing comments, since ownership is checked
-- by guest_id. The intent was already written down in register()'s doc
-- comment — "a device switch requires possession of the email account" —
-- it just was not enforced anywhere.
--
-- Now only verify() marks a session verified, on the session it issues.
ALTER TABLE guest_sessions
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Sessions that already exist were created under the old rule and are in
-- browsers belonging to people who did verify at some point. Backfilling
-- them keeps those visitors able to comment; the new rule applies to every
-- session issued from here on.
UPDATE guest_sessions s
   SET verified_at = g.verified_at
  FROM guests g
 WHERE g.id = s.guest_id
   AND g.verified_at IS NOT NULL
   AND s.verified_at IS NULL;
