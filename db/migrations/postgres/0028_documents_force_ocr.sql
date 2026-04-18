-- Migration 0028: Per-document force-OCR flag.
--
-- Some scanned PDFs ship with a pre-baked text layer that lost its
-- spaces (text positioned by x-coordinate without explicit space
-- glyphs). `pdf-parse` returns that text verbatim, so our classifier
-- sees one long glued-together word. Setting `force_ocr = true` on a
-- document tells the text-extract worker to skip the text layer and
-- rasterize + tesseract the PDF instead. Default `false` keeps the
-- fast happy path for digital PDFs.

ALTER TABLE documents
  ADD COLUMN force_ocr BOOLEAN NOT NULL DEFAULT false;
