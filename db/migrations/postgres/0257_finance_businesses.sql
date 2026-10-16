-- Businesses in the tax sense (documentation/plans/betriebe-euer.md,
-- stage 1): a leased farm, a photovoltaic system, a trade — each with its
-- fixed assets and, for a farm, its parcels. The depreciation schedule is
-- computed from the asset's cost, rate and dates, never stored.
CREATE TABLE "finance_business" (
  "id" serial PRIMARY KEY,
  "owner_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "tax_section" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "finance_business_by_owner" ON "finance_business" ("owner_user_id");
--> statement-breakpoint
CREATE TABLE "finance_business_asset" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL REFERENCES "finance_business"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "acquisition_date" date NOT NULL,
  "acquisition_cost" numeric(14, 2) NOT NULL,
  "afa_rate_pct" numeric(6, 3) NOT NULL DEFAULT 0,
  "afa_start_date" date,
  "disposal_date" date,
  "disposal_proceeds" numeric(14, 2),
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "finance_business_asset_by_business" ON "finance_business_asset" ("business_id");
--> statement-breakpoint
CREATE TABLE "finance_business_parcel" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL REFERENCES "finance_business"("id") ON DELETE CASCADE,
  "asset_id" integer REFERENCES "finance_business_asset"("id") ON DELETE SET NULL,
  "gemarkung" text NOT NULL,
  "flur" text,
  "flurstueck" text NOT NULL,
  "area_m2" integer,
  "usage" text NOT NULL DEFAULT 'acker',
  "lessee" text,
  "lease_from" date,
  "lease_to" date,
  "annual_rent" numeric(14, 2),
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "finance_business_parcel_by_business" ON "finance_business_parcel" ("business_id");
