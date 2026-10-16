-- Whether a schedule's mails carry the owner's own address as sender
-- instead of the app's (#1548). Only honoured while the owner's address
-- shares the app's domain; off by default.
ALTER TABLE "collection_schedules" ADD COLUMN "send_as_self" boolean NOT NULL DEFAULT false;
