CREATE TABLE taxonomy_snapshots (
  id            SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL UNIQUE,
  total_documents       INT NOT NULL DEFAULT 0,
  classified_documents  INT NOT NULL DEFAULT 0,
  sonstiges_count       INT NOT NULL DEFAULT 0,
  sonstiges_pct         REAL NOT NULL DEFAULT 0,
  avg_confidence        REAL,
  low_confidence_count  INT NOT NULL DEFAULT 0,
  teacher_requested_count INT NOT NULL DEFAULT 0,
  open_suggestions_count  INT NOT NULL DEFAULT 0,
  category_count        INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
