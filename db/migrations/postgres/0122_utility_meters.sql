-- Utility meters module (Issue #792, Etappe 1).
--
-- Model: `meters` is the logical metering point (persists across device
-- swaps), `meter_devices` the physical device installed there for a period.
-- A device starts at an arbitrary start_value (often 0 after a swap); the
-- absolute total of a metering point is the sum of per-device consumption
-- ((end_value or latest reading) - start_value) and is monotonic.

CREATE TABLE meters (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('electricity', 'water', 'gas', 'operating_hours')),
  unit TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  photo_path TEXT,
  -- Decimal places offered in entry forms / display (mechanical meters
  -- usually show 1-3 red fraction digits).
  decimals INTEGER NOT NULL DEFAULT 1 CHECK (decimals >= 0 AND decimals <= 3),
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Visibility: owner + members of group_id (same groups concept as the
  -- documents module). NULL = private to the owner.
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX meters_owner_idx ON meters(owner_user_id);
CREATE INDEX meters_group_idx ON meters(group_id);

CREATE TABLE meter_devices (
  id SERIAL PRIMARY KEY,
  meter_id INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  serial_number TEXT,
  installed_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ,          -- NULL = currently installed device
  start_value NUMERIC(14,3) NOT NULL DEFAULT 0,
  end_value NUMERIC(14,3),         -- final reading at removal, NULL while active
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (removed_at IS NULL OR removed_at >= installed_at),
  CHECK (end_value IS NULL OR end_value >= start_value)
);
-- At most one active (not yet removed) device per metering point.
CREATE UNIQUE INDEX meter_devices_one_active ON meter_devices(meter_id) WHERE removed_at IS NULL;
CREATE INDEX meter_devices_meter_idx ON meter_devices(meter_id);

CREATE TABLE meter_api_keys (
  id SERIAL PRIMARY KEY,
  meter_id INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- SHA-256 hex of the bearer token; the plaintext token is only shown once
  -- in the create response.
  key_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ
);
CREATE INDEX meter_api_keys_meter_idx ON meter_api_keys(meter_id);

CREATE TABLE meter_readings (
  id BIGSERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES meter_devices(id) ON DELETE CASCADE,
  value NUMERIC(14,3) NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr', 'api')),
  photo_path TEXT,                 -- photo the value was OCR'd from
  ocr_confidence REAL,             -- 0..1, only for source='ocr'
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL for source='api'
  api_key_id INTEGER REFERENCES meter_api_keys(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency anchor for API ingestion: devices re-send the same
  -- (timestamp, value) after connection loss.
  UNIQUE (device_id, taken_at)
);
CREATE INDEX meter_readings_device_taken_idx ON meter_readings(device_id, taken_at DESC);

-- Link payments (advance payments, annual settlement) to a reading.
-- Same pattern as finance_transaction_document (migration 0108).
CREATE TABLE meter_reading_transactions (
  reading_id BIGINT NOT NULL REFERENCES meter_readings(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reading_id, transaction_id)
);
