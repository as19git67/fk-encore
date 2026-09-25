-- Retirement forecast (issue #1337): when can I — or we — stop working?
--
-- Four tables, all owned by a user. A household is the set of persons a
-- user has entered; each person has milestones (leaving work, pension
-- start, insurance maturity, …) given as a date or an age. Items are the
-- money side — salary, pensions, insurances, assets, expenses — and refer
-- to milestones for their start and end, so moving a milestone moves
-- everything that hangs on it. Their type-specific fields live in jsonb,
-- because eight item types with mostly disjoint fields would make a
-- forty-column table that is wide and still nullable everywhere.
--
-- Scenarios do not copy items. They hold the assumptions (inflation,
-- return, tax, spending curve, withdrawal order) and overrides for
-- milestones, so "A leaves at 60" and "A leaves at 63" share one set of
-- items and differ in one number.

CREATE TABLE finance_forecast_person (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  birth_date DATE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_finance_forecast_person_user ON finance_forecast_person (user_id);

CREATE TABLE finance_forecast_milestone (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES finance_forecast_person(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  date DATE,
  age INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finance_forecast_milestone_kind_check CHECK (
    kind IN ('leave_work', 'statutory_pension', 'company_pension',
             'private_pension', 'life_insurance_maturity', 'custom')
  ),
  CONSTRAINT finance_forecast_milestone_when_check CHECK (
    (date IS NOT NULL AND age IS NULL) OR (date IS NULL AND age IS NOT NULL)
  )
);
CREATE INDEX idx_finance_forecast_milestone_person ON finance_forecast_milestone (person_id);

CREATE TABLE finance_forecast_item (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL = household item (shared depot, living expenses, loans).
  person_id INTEGER REFERENCES finance_forecast_person(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  data JSONB NOT NULL,
  -- An asset can take its current value from a finance account.
  linked_account_id INTEGER REFERENCES finance_account(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finance_forecast_item_type_check CHECK (
    type IN ('salary', 'income', 'expense', 'living_expense',
             'health_insurance', 'asset', 'life_insurance', 'pension')
  )
);
CREATE INDEX idx_finance_forecast_item_user ON finance_forecast_item (user_id);

CREATE TABLE finance_forecast_scenario (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_finance_forecast_scenario_user ON finance_forecast_scenario (user_id);
