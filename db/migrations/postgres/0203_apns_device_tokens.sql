-- iOS device tokens for Apple Push Notification service (#765).
--
-- The web has push_subscriptions (one row per browser, VAPID keys); the
-- iOS app has no browser and no service worker. APNs works the other way
-- round: the phone hands the app an opaque token, the app hands it to us,
-- and we send to Apple with a provider token of our own. One row per
-- device. A token is globally unique, so a re-registration from the same
-- phone upserts its row rather than adding one; Apple's "Unregistered"
-- answer removes it.
--
-- `environment` says which Apple gateway the token belongs to: a build
-- from Xcode registers against the sandbox, an App Store or TestFlight
-- build against production. Sending a sandbox token to production (or the
-- reverse) is answered with BadDeviceToken, so the row remembers.
CREATE TABLE IF NOT EXISTS "apns_device_tokens" (
  "id" bigserial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "environment" text NOT NULL DEFAULT 'production',
  "device_name" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_apns_device_tokens_user" ON "apns_device_tokens" ("user_id");
