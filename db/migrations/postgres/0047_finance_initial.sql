-- Migration 0043: Finance module initial schema.
--
-- Greenfield finance module. Replaces the legacy Finanzkraft concepts
-- (category tree + rule engine + per-role bank access) with:
--
--   - flat multi-label tags (finance_tag / finance_tag_transaction),
--     with `source ∈ {user, ai}` so KI suggestions never overwrite
--     user-confirmed tags;
--   - row-level account access (finance_account_access) replacing the
--     legacy Fk_AccountReader / Fk_AccountWriter roles;
--   - a database-backed TAN session (finance_tan_session) so the TAN
--     dialog state survives process restarts and is not bound to a
--     single Encore instance;
--   - AES-GCM-encrypted credentials in finance_bankcontact.credentials_
--     encrypted (key = Encore secret FinanceCredentialsKey).
--
-- Architecture: docs/finance-data-model.md.


-- ---------- Enums ----------

CREATE TYPE finance_account_level AS ENUM ('read', 'write');

CREATE TYPE finance_tag_source AS ENUM ('user', 'ai');

CREATE TYPE finance_account_kind AS ENUM (
    'giro',
    'tagesgeld',
    'festgeld',
    'kredit',
    'depot',
    'bausparen',
    'kreditkarte',
    'sonstige'
);


-- ---------- Stammdaten ----------

CREATE TABLE finance_currency (
    code     TEXT PRIMARY KEY,            -- ISO 4217, e.g. 'EUR', 'USD'
    symbol   TEXT NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE finance_account_type (
    id    SERIAL PRIMARY KEY,
    kind  finance_account_kind NOT NULL UNIQUE,
    label TEXT NOT NULL
);

CREATE TABLE finance_timespan (
    id            SERIAL PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    offset_days   INTEGER,
    offset_months INTEGER
);


-- ---------- Bankkontakte ----------
--
-- sync_times is an array of cron-like slots, e.g.
--   [{ "weekdays": [1,2,3,4,5], "time": "06:25", "tz": "Europe/Berlin" }]
-- The sync cron evaluates each slot against now() in the declared tz;
-- DST transitions therefore don't require a separate UTC cache column.

CREATE TABLE finance_bankcontact (
    id                    SERIAL PRIMARY KEY,
    name                  TEXT NOT NULL,
    blz                   TEXT NOT NULL,
    login                 TEXT NOT NULL,
    server_url            TEXT NOT NULL,
    tan_method            TEXT,
    credentials_encrypted TEXT,                                      -- AES-GCM blob, base64
    sync_times            JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_sync_at          TIMESTAMP WITH TIME ZONE,
    last_sync_status      TEXT,
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE finance_account (
    id                   SERIAL PRIMARY KEY,
    -- Optional: NULL means "manual account", not linked to a bank.
    -- On bankcontact-delete we unlink (set to NULL) instead of cascading,
    -- so the user's bookings survive when the bank connection goes away.
    bankcontact_id       INTEGER REFERENCES finance_bankcontact(id)
                           ON DELETE SET NULL,
    -- lib-fints' accountNumber for the matching bank-side account, when
    -- linked. Used by the statement-fetch path to map bank snapshots
    -- to fk-encore accounts. NULL for manual accounts.
    fints_account_number TEXT,
    type_id              INTEGER NOT NULL REFERENCES finance_account_type(id)
                           ON DELETE RESTRICT,
    currency_code        TEXT NOT NULL REFERENCES finance_currency(code)
                           ON DELETE RESTRICT,
    iban                 TEXT UNIQUE,
    account_number       TEXT NOT NULL,
    label                TEXT NOT NULL,
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    -- Only one fk-encore account may be bound to a given (bankcontact,
    -- fints_account_number) pair at a time, so the statement-fetch
    -- path doesn't have to disambiguate.
    CONSTRAINT finance_account_unique_bank_link
        UNIQUE (bankcontact_id, fints_account_number)
);


-- ---------- Konto-ACL ----------

CREATE TABLE finance_account_access (
    account_id INTEGER NOT NULL REFERENCES finance_account(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)           ON DELETE CASCADE,
    level      finance_account_level NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, user_id)
);


-- ---------- Transaktionen + Salden ----------
--
-- dedupe_hash = SHA-256 over (booking_date, value_date, amount,
-- currency, purpose, counterparty_iban). When the bank provides a
-- stable fints_id the importer prefers that; dedupe_hash is the
-- fallback for manual bookings and imports where fints_id is missing.

CREATE TABLE finance_transaction (
    id                BIGSERIAL PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES finance_account(id)
                        ON DELETE RESTRICT,
    booking_date      TIMESTAMP NOT NULL,
    value_date        TIMESTAMP,
    amount            NUMERIC(12, 2) NOT NULL,
    currency_code     TEXT NOT NULL REFERENCES finance_currency(code)
                        ON DELETE RESTRICT,
    purpose           TEXT,
    counterparty      TEXT,
    counterparty_iban TEXT,
    fints_id          TEXT,
    dedupe_hash       TEXT NOT NULL,
    raw               JSONB,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX finance_transaction_dedupe_unique
    ON finance_transaction (account_id, dedupe_hash);

CREATE INDEX finance_transaction_account_booking_idx
    ON finance_transaction (account_id, booking_date);

CREATE TABLE finance_account_balance (
    account_id INTEGER NOT NULL REFERENCES finance_account(id) ON DELETE CASCADE,
    as_of      TIMESTAMP WITH TIME ZONE NOT NULL,
    balance    NUMERIC(14, 2) NOT NULL,
    source     TEXT NOT NULL,                 -- 'fints' | 'manual' | 'import'
    PRIMARY KEY (account_id, as_of)
);


-- ---------- Tags ----------
--
-- Same tag name can exist once per source — promotion deletes the 'ai'
-- row and upserts a 'user' row (confidence becomes NULL).

CREATE TABLE finance_tag (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    source     finance_tag_source NOT NULL DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX finance_tag_name_source_unique
    ON finance_tag (name, source);

CREATE TABLE finance_tag_transaction (
    tag_id         INTEGER NOT NULL REFERENCES finance_tag(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES finance_transaction(id)
                     ON DELETE CASCADE,
    confidence     NUMERIC(4, 3),         -- NULL for source='user' rows
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (tag_id, transaction_id)
);

CREATE INDEX finance_tag_transaction_transaction_idx
    ON finance_tag_transaction (transaction_id);


-- ---------- TAN-Sessions + System-Preferences ----------

CREATE TABLE finance_tan_session (
    tan_reference       UUID PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bankcontact_id      INTEGER NOT NULL REFERENCES finance_bankcontact(id)
                          ON DELETE CASCADE,
    banking_information JSONB NOT NULL,
    challenge           TEXT NOT NULL,
    expires_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX finance_tan_session_expires_idx
    ON finance_tan_session (expires_at);

CREATE TABLE finance_system_pref (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);


-- ---------- Seeds (reference data) ----------
--
-- Currency, account-type and timespan rows live with the schema —
-- they're needed before any business logic runs and never change per
-- environment.

INSERT INTO finance_currency (code, symbol, decimals) VALUES
    ('EUR', '€', 2),
    ('USD', '$', 2);

INSERT INTO finance_account_type (kind, label) VALUES
    ('giro',        'Girokonto'),
    ('tagesgeld',   'Tagesgeld'),
    ('festgeld',    'Festgeld'),
    ('kredit',      'Kreditkonto'),
    ('depot',       'Depot'),
    ('bausparen',   'Bausparvertrag'),
    ('kreditkarte', 'Kreditkarte'),
    ('sonstige',    'Sonstiges Konto');

INSERT INTO finance_timespan (slug, label, offset_days, offset_months) VALUES
    ('current-month', 'Aktueller Monat', NULL, 0),
    ('last-month',    'Letzter Monat',   NULL, -1),
    ('current-year',  'Aktuelles Jahr',  NULL, NULL),
    ('last-year',     'Letztes Jahr',    NULL, -12),
    ('last-30-days',  'Letzte 30 Tage',  -30,  NULL),
    ('last-90-days',  'Letzte 90 Tage',  -90,  NULL);
