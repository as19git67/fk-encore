/**
 * Lays the planned meters, tariffs and PV business down (documentation/
 * plans/demodaten.md, stage 5). Meters, readings and tariffs go through
 * the meter service's own functions — the same validation as the
 * endpoints, without their auth layer, because the run is a background
 * job of the admin. The business and its asset are written like the
 * business endpoint writes them. Every top-level row is registered; devices,
 * readings and assets go with their parent.
 */

import { inArray } from "drizzle-orm";
import db from "../db/database";
import { financeBusiness, financeBusinessAsset, meterElectricityTariffs, meters } from "../db/schema";
import { defaultBookingTag, defaultEuerLines } from "../finance/euer";
import { createMeter } from "../meter/meter.service";
import { addReading } from "../meter/readings.service";
import { createElectricityTariff } from "../meter/tariffs.service";
import type { EnergyPlan } from "./energy";
import { register } from "./registry";
import { DemoCancelled, type WriteHooks } from "./writer";

export interface WrittenEnergy {
  meters: number;
  readings: number;
  tariffs: number;
  businessId: number;
}

function euros(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function writeEnergy(runId: number, ownerId: number, plan: EnergyPlan, hooks: WriteHooks = {}): Promise<WrittenEnergy> {
  const total = plan.meters.reduce((s, m) => s + m.readings.length, 0);
  let readings = 0;
  for (const m of plan.meters) {
    if (hooks.cancelled && (await hooks.cancelled())) throw new DemoCancelled();
    const { id } = await createMeter(ownerId, {
      name: m.name,
      type: m.type,
      role: m.role,
      unit: m.unit,
      decimals: m.decimals,
      location: m.location,
      device: { installedAt: m.readings[0].takenAt, startValue: m.startValue, serialNumber: m.serialNumber },
    });
    // Registered right away: if a reading fails, removal still finds the meter.
    await register(runId, "meters", [id]);
    for (const r of m.readings) {
      await addReading(ownerId, id, { value: r.value, takenAt: r.takenAt });
      readings += 1;
    }
    await hooks.progress?.(readings, total);
  }

  const tariffIds: number[] = [];
  for (const t of plan.tariffs) {
    const row = await createElectricityTariff(ownerId, { kind: t.kind, validFrom: t.validFrom, amount: t.amount, unit: t.unit, name: t.name });
    tariffIds.push(row.id);
  }
  await register(runId, "meter_electricity_tariffs", tariffIds);

  const [business] = await db
    .insert(financeBusiness)
    .values({
      owner_user_id: ownerId,
      name: plan.pv.name,
      kind: "photovoltaik",
      tax_section: "anlage-g",
      booking_tag: defaultBookingTag("photovoltaik"),
      euer_lines: defaultEuerLines("photovoltaik"),
      pv_capacity_kwp: plan.pv.capacityKwp.toFixed(3),
      pv_commissioned_on: plan.pv.commissionedOn,
      notes: "Dachanlage mit Zweirichtungszähler; Einspeisung nach EEG.",
    })
    .returning({ id: financeBusiness.id });
  await register(runId, "finance_business", [business.id]);
  await db.insert(financeBusinessAsset).values({
    business_id: business.id,
    name: `Photovoltaikanlage ${plan.pv.capacityKwp.toLocaleString("de-DE")} kWp`,
    kind: "pv_anlage",
    acquisition_date: plan.pv.commissionedOn,
    acquisition_cost: euros(plan.pv.costCents),
    afa_rate_pct: plan.pv.afaRatePct.toFixed(3),
    afa_start_date: plan.pv.commissionedOn,
  });

  return { meters: plan.meters.length, readings, tariffs: tariffIds.length, businessId: business.id };
}

/** Takes the registered meters, tariffs and businesses back; devices, readings and assets cascade. */
export async function removeEnergy(ids: { meters: number[]; tariffs: number[]; businesses: number[] }): Promise<void> {
  if (ids.businesses.length) await db.delete(financeBusiness).where(inArray(financeBusiness.id, ids.businesses));
  if (ids.meters.length) await db.delete(meters).where(inArray(meters.id, ids.meters));
  if (ids.tariffs.length) await db.delete(meterElectricityTariffs).where(inArray(meterElectricityTariffs.id, ids.tariffs));
}
