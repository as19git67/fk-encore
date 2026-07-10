import { apiFetch } from './client'

export type MeterType = 'electricity' | 'water' | 'gas' | 'operating_hours'
export type MeterRole = 'grid_import' | 'grid_export' | 'pv_production'

export interface MeterListItem {
  id: number
  name: string
  type: MeterType
  role: MeterRole | null
  unit: string
  location: string | null
  notes: string | null
  decimals: number
  groupId: number | null
  ownerUserId: number
  activeDeviceSerial: string | null
  lastReadingValue: number | null
  lastReadingAt: string | null
  absoluteTotal: number
}

export interface MeterDevice {
  id: number
  serialNumber: string | null
  installedAt: string
  removedAt: string | null
  startValue: number
  endValue: number | null
  notes: string | null
  active: boolean
}

export interface MeterDetail extends MeterListItem {
  createdAt: string
  updatedAt: string
  photoPath: string | null
  devices: MeterDevice[]
}

export interface InitialDeviceInput {
  serialNumber?: string
  installedAt: string
  startValue?: number
}

export interface CreateMeterRequest {
  name: string
  type: MeterType
  role?: MeterRole | null
  unit: string
  location?: string
  notes?: string
  decimals?: number
  groupId?: number | null
  device: InitialDeviceInput
}

export interface UpdateMeterRequest {
  name: string
  type: MeterType
  role?: MeterRole | null
  unit: string
  location?: string
  notes?: string
  decimals?: number
  groupId?: number | null
}

export interface ReplaceDeviceRequest {
  swapAt: string
  finalValue: number
  newSerialNumber?: string
  newStartValue?: number
}

export function listMeters() {
  return apiFetch<{ meters: MeterListItem[] }>('/meters')
}

export function getMeter(id: number) {
  return apiFetch<MeterDetail>(`/meters/${id}`)
}

export function createMeter(req: CreateMeterRequest) {
  return apiFetch<{ id: number }>('/meters', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function updateMeter(id: number, req: UpdateMeterRequest) {
  return apiFetch<MeterDetail>(`/meters/${id}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

export function deleteMeter(id: number) {
  return apiFetch<{ deleted: boolean }>(`/meters/${id}`, {
    method: 'DELETE',
  })
}

export function replaceMeterDevice(id: number, req: ReplaceDeviceRequest) {
  return apiFetch<{ newDeviceId: number }>(`/meters/${id}/replace-device`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

// ── Readings (Etappe 3) ──────────────────────────────────────────────────────

export interface Reading {
  id: number
  deviceId: number
  deviceSerial: string | null
  value: number
  takenAt: string
  source: string
  notes: string | null
  enteredBy: number | null
  absoluteValue: number
}

export interface AddReadingRequest {
  value: number
  takenAt?: string
  notes?: string
  source?: 'manual' | 'ocr'
  photoPath?: string
  ocrConfidence?: number
}

export interface UpdateReadingRequest {
  value: number
  takenAt: string
  notes?: string
}

export function listReadings(meterId: number, limit = 100, offset = 0) {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return apiFetch<{ readings: Reading[]; total: number }>(`/meters/${meterId}/readings?${q}`)
}

export function addReading(meterId: number, req: AddReadingRequest) {
  return apiFetch<{ id: number }>(`/meters/${meterId}/readings`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function updateReading(readingId: number, req: UpdateReadingRequest) {
  return apiFetch<{ updated: boolean }>(`/meters/readings/${readingId}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

export function deleteReading(readingId: number) {
  return apiFetch<{ deleted: boolean }>(`/meters/readings/${readingId}`, {
    method: 'DELETE',
  })
}

// ── Reports (Etappe 6) ──────────────────────────────────────────────────────

export type MeterReportGranularity = 'month' | 'year'

export interface MeterReportBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  startReadingAt: string
  endReadingAt: string
  startValue: number
  endValue: number
  consumption: number
  intervals: number
}

export interface MeterReport {
  meterId: number
  name: string
  unit: string
  decimals: number
  granularity: MeterReportGranularity
  from: string | null
  to: string | null
  buckets: MeterReportBucket[]
  totalConsumption: number
}

export function getMeterReport(meterId: number, granularity: MeterReportGranularity = 'month') {
  const q = new URLSearchParams({ granularity })
  return apiFetch<MeterReport>(`/meters/${meterId}/report?${q}`)
}

export type EnergyReportRole = MeterRole

export interface EnergyReportMeterRef {
  role: EnergyReportRole
  meterId: number
  name: string
}

export interface EnergyReportBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  gridImport: number | null
  gridExport: number | null
  production: number | null
  selfConsumption: number | null
  totalConsumption: number | null
  autarky: number | null
  selfConsumptionRate: number | null
}

export interface EnergyReport {
  unit: string
  decimals: number
  granularity: MeterReportGranularity
  from: string | null
  to: string | null
  meters: EnergyReportMeterRef[]
  missingRoles: EnergyReportRole[]
  buckets: EnergyReportBucket[]
  totals: Omit<EnergyReportBucket, 'key' | 'label' | 'periodStart' | 'periodEnd'>
}

export function getEnergyReport(granularity: MeterReportGranularity = 'month') {
  const q = new URLSearchParams({ granularity })
  return apiFetch<EnergyReport>(`/meters/reports/energy?${q}`)
}

// ── Import (Issue #792) ─────────────────────────────────────────────────────

export interface WaterImportResult {
  meterId: number
  devices: number
  readings: number
  alreadyImported: boolean
}

export function importWaterHistory() {
  return apiFetch<WaterImportResult>('/meters/import/water-history', {
    method: 'POST',
  })
}

export interface ElecImportResult {
  metersCreated: number
  devicesCreated: number
  readingsCreated: number
  alreadyImported: boolean
}

export function importElectricityHistory() {
  return apiFetch<ElecImportResult>('/meters/import/electricity-history', {
    method: 'POST',
  })
}

// ── API Keys (Etappe 5) ─────────────────────────────────────────────────────

export interface ApiKey {
  id: number
  meterId: number
  name: string
  createdAt: string
  lastUsedAt: string | null
  disabledAt: string | null
}

export interface CreateApiKeyResult extends ApiKey {
  token: string
}

export function listApiKeys(meterId: number) {
  return apiFetch<{ keys: ApiKey[] }>(`/meters/${meterId}/api-keys`)
}

export function createApiKey(meterId: number, name: string) {
  return apiFetch<CreateApiKeyResult>(`/meters/${meterId}/api-keys`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function deleteApiKey(keyId: number) {
  return apiFetch<{ deleted: boolean }>(`/meters/api-keys/${keyId}`, {
    method: 'DELETE',
  })
}

// ── OCR (Etappe 4) ─────────────────────────────────────────────────────────

export interface MeterOcrResult {
  value: number | null
  confidence: number
  photoPath: string
  rawText: string
}

export function ocrMeterReading(meterId: number, imageFile: File) {
  return apiFetch<MeterOcrResult>(`/meters/${meterId}/readings/ocr`, {
    method: 'POST',
    body: imageFile,
    headers: {
      'Content-Type': imageFile.type || 'image/jpeg',
      'X-File-Name': imageFile.name,
    },
  })
}

/** Human-readable German labels for the meter types. */
export const METER_TYPE_LABELS: Record<MeterType, string> = {
  electricity: 'Strom',
  water: 'Wasser',
  gas: 'Gas',
  operating_hours: 'Betriebsstunden',
}

/** PrimeIcons class per meter type, for list/detail rendering. */
export const METER_TYPE_ICONS: Record<MeterType, string> = {
  electricity: 'pi pi-bolt',
  water: 'pi pi-cloud',
  gas: 'pi pi-cloud',
  operating_hours: 'pi pi-clock',
}
