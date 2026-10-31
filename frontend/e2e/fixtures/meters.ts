import { adminApi } from './api'

// Seeding helpers for the Zähler specs (documentation/handbuch/zaehler.md).
//
// Every spec builds its own meters through the REST API with a unique name,
// so specs running in parallel never see each other's data, and a re-run
// against the same database starts from what it created itself. All values
// are invented test data.

export type MeterType = 'electricity' | 'water' | 'gas' | 'operating_hours'

export interface SeedMeter {
  name: string
  type?: MeterType
  role?: string | null
  unit?: string
  decimals?: number
  location?: string
  serialNumber?: string
  /** Installation of the first device; defaults to two years ago. */
  installedAt?: Date
  startValue?: number
}

export interface SeededMeter {
  id: number
  name: string
}

const DEFAULT_UNIT: Record<MeterType, string> = {
  electricity: 'kWh',
  water: 'm³',
  gas: 'm³',
  operating_hours: 'h',
}

const DAY_MS = 86_400_000

/** A name nobody else in this run uses: `prefix` plus a short random tail. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
}

export function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days * DAY_MS)
}

async function call<T>(method: string, path: string, data?: unknown): Promise<T> {
  const { ctx } = await adminApi()
  const res = await ctx.fetch(path, { method, data })
  if (!res.ok()) {
    throw new Error(`[e2e] ${method} ${path} failed: ${res.status()} ${await res.text()}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function createMeter(input: SeedMeter): Promise<SeededMeter> {
  const type = input.type ?? 'electricity'
  const { id } = await call<{ id: number }>('POST', '/meters', {
    name: input.name,
    type,
    role: input.role ?? null,
    unit: input.unit ?? DEFAULT_UNIT[type],
    decimals: input.decimals ?? 0,
    location: input.location,
    // Private: no household is involved unless a spec sets one up itself.
    groupId: null,
    device: {
      serialNumber: input.serialNumber,
      installedAt: (input.installedAt ?? daysAgo(730)).toISOString(),
      startValue: input.startValue ?? 0,
    },
  })
  return { id, name: input.name }
}

export async function deleteMeter(id: number): Promise<void> {
  await call('DELETE', `/meters/${id}`)
}

export async function addReading(meterId: number, value: number, takenAt: Date, notes?: string): Promise<number> {
  const { id } = await call<{ id: number }>('POST', `/meters/${meterId}/readings`, {
    value,
    takenAt: takenAt.toISOString(),
    notes,
  })
  return id
}

/**
 * `count` readings, one every `everyDays` days, ending `endDaysAgo` days ago,
 * each `step` above the one before. A constant step gives a flat daily rate,
 * which keeps the anomaly check quiet.
 */
export async function addReadingSeries(
  meterId: number,
  opts: { count: number; everyDays: number; step: number; startValue?: number; endDaysAgo?: number },
): Promise<number[]> {
  const ids: number[] = []
  const end = daysAgo(opts.endDaysAgo ?? 1)
  for (let i = 0; i < opts.count; i++) {
    const at = daysAgo((opts.count - 1 - i) * opts.everyDays, end)
    ids.push(await addReading(meterId, (opts.startValue ?? 0) + (i + 1) * opts.step, at))
  }
  return ids
}

export interface MeterDetail {
  id: number
  name: string
  lastReadingValue: number | null
  absoluteTotal: number | null
  activeDeviceSerial: string | null
  devices: Array<{ id: number; serialNumber: string | null; active: boolean }>
}

export async function getMeter(id: number): Promise<MeterDetail> {
  return call<MeterDetail>('GET', `/meters/${id}`)
}

export async function createApiKey(meterId: number, name: string): Promise<void> {
  await call('POST', `/meters/${meterId}/api-keys`, { name })
}

export async function saveQuickEntry(meterIds: number[]): Promise<void> {
  await call('PUT', '/meters/quick-entry', { meterIds })
}

export async function createCollection(name: string, meterIds: number[]): Promise<number> {
  const { id } = await call<{ id: number }>('POST', '/collections', {
    name,
    members: meterIds.map((id) => ({ entity_type: 'meter', entity_id: id })),
  })
  return id
}

export async function createGroup(name: string): Promise<number> {
  const { id } = await call<{ id: number }>('POST', '/groups', { name })
  return id
}

export async function setHousehold(groupId: number | null): Promise<void> {
  await call('PUT', '/meters/household', { groupId })
}

export async function runAnomalyCheck(): Promise<void> {
  await call('POST', '/meters/anomalies/run', {})
}

export async function createTariff(input: {
  kind: string
  validFrom: string
  amount: number
  unit: string
  name: string
}): Promise<number> {
  const { id } = await call<{ id: number }>('POST', '/meters/tariffs/electricity', input)
  return id
}
