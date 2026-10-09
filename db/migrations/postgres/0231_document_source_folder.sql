-- Where a document came from, before fk-encore filed it by category.
--
-- The folder tree a household kept before the import was the only link
-- between a policy, its terms and conditions and the later letters: nothing
-- on the terms names the policy number, so once the folder is gone, so is the
-- connection. `source_folder` keeps that folder as a relative path under the
-- inbox root (or under the uploaded folder), `/`-separated, without a leading
-- slash. NULL means the file arrived on its own at the root. It is data about
-- the document, never a filing location: `disk_path` stays the one place a
-- file lives.
ALTER TABLE "documents" ADD COLUMN "source_folder" text;
CREATE INDEX "documents_source_folder_idx" ON "documents" ("source_folder");
