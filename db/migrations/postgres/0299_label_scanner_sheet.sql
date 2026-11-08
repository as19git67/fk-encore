-- Scanner labels (label/scanner-sheet.ts): every generated A4 sheet of
-- numbered stickers "#0001" … The PDF is rendered again on download from
-- the first number and the page count, so no file is kept. The next number
-- lives in users.label_prefs (scannerNextNumber).
CREATE TABLE IF NOT EXISTS label_scanner_sheet (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_number INTEGER NOT NULL,
  pages INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS label_scanner_sheet_user_idx ON label_scanner_sheet (user_id, created_at);
