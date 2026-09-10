-- Accounts by invitation only.
--
-- `POST /users` was open to the internet: anyone who could reach the app
-- could create an account. New accounts carried no roles, so it was never a
-- way in — but it was an account factory, and it made every
-- authenticated-but-unauthorized gap elsewhere anonymously reachable.
--
-- The gate is a token mailed to a named address by somebody holding
-- `users.create` — a permission that already existed in the catalogue and
-- until now was never checked anywhere, because there was nothing to check
-- it on.
--
-- What an invite does not carry is roles. Letting the inviter pre-assign
-- them would make `users.create` alone sufficient to mint an admin; roles
-- stay behind `roles.assign`, as a separate step by someone who holds it.
CREATE TABLE IF NOT EXISTS user_invites (
  id serial PRIMARY KEY,
  token text NOT NULL UNIQUE,
  -- The account is created for this address rather than for whatever the
  -- registration form sends, so an invite cannot be pointed somewhere else.
  email text NOT NULL,
  -- Audit trail only, and nullable: an invite outlives the account that
  -- sent it.
  invited_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set on redemption. The row stays behind so a token is never accepted
  -- twice and the admin list can show what became of each invite.
  accepted_at timestamptz
);

-- Looked up per address when checking for an account or an open invite.
CREATE INDEX IF NOT EXISTS user_invites_email_idx ON user_invites (email);
