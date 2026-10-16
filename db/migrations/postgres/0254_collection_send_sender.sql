-- The From address of every mail sent with a collection's export: the
-- sender's own address, or the app's for an automatic export someone mails
-- to themselves (#1548).
ALTER TABLE "collection_sends" ADD COLUMN "sender" text;
