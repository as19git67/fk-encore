-- Photovoltaics (documentation/plans/betriebe-euer.md, stage 3): the
-- system's capacity and commissioning date on the business, and an
-- optional override of the § 3 Nr. 72 EStG exemption the server derives
-- from them ('exempt' or 'taxable'; NULL = derive).
ALTER TABLE "finance_business" ADD COLUMN "pv_capacity_kwp" numeric(7,3);
--> statement-breakpoint
ALTER TABLE "finance_business" ADD COLUMN "pv_commissioned_on" date;
--> statement-breakpoint
ALTER TABLE "finance_business" ADD COLUMN "pv_tax_override" text;
