import { apiFetch } from './client'

export type MeterType = 'electricity' | 'water' | 'gas' | 'operating_hours'
export type MeterRole =
  | 'grid_import'
  | 'grid_export'
  | 'pv_production'
  | 'heat_pump_total'
  | 'heat_heating_total'
  | 'heat_heating_pv'
  | 'hot_water_total'
  | 'hot_water_pv'
  | 'ev_charger_total'
  | 'ev_charger_pv'

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
  readingCount: number
  canDelete: boolean
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

export interface UpdateMeterDeviceRequest {
  serialNumber?: string | null
  installedAt: string
  startValue: number
  removedAt?: string | null
  endValue?: number | null
  notes?: string | null
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

export function updateMeterDevice(deviceId: number, req: UpdateMeterDeviceRequest) {
  return apiFetch<{ updated: boolean }>(`/meters/devices/${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

export function deleteMeterDevice(deviceId: number) {
  return apiFetch<{ deleted: boolean }>(`/meters/devices/${deviceId}`, {
    method: 'DELETE',
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

// ── Quick entry ─────────────────────────────────────────────────────────────

export interface QuickEntryItem extends MeterListItem {
  sortOrder: number
}

export interface QuickEntryConfig {
  items: QuickEntryItem[]
  availableMeters: MeterListItem[]
}

export function getQuickEntryConfig() {
  return apiFetch<QuickEntryConfig>('/meters/quick-entry')
}

export function saveQuickEntryConfig(meterIds: number[]) {
  return apiFetch<QuickEntryConfig>('/meters/quick-entry', {
    method: 'PUT',
    body: JSON.stringify({ meterIds }),
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
  /** Share of the period actually spanned by readings, 0..1. */
  coverage: number
  /** Same period one year earlier; null unless both periods are fully covered. */
  previousConsumption: number | null
  deltaAbsolute: number | null
  deltaPercent: number | null
}

/**
 * How an interval between two readings is charged to report buckets.
 * `interpolated` spreads it over the periods it overlaps; `interval_start` is
 * the original Excel logic that charges it to the period it starts in.
 */
export type MeterReportAllocation = 'interpolated' | 'interval_start'

/** Coverage from which a period counts as fully measured (backend rule). */
export const COMPLETE_COVERAGE_THRESHOLD = 0.99

export function isCompletePeriod(bucket: { coverage: number }) {
  return bucket.coverage >= COMPLETE_COVERAGE_THRESHOLD
}

export interface MeterReport {
  meterId: number
  name: string
  unit: string
  decimals: number
  granularity: MeterReportGranularity
  allocation: MeterReportAllocation
  from: string | null
  to: string | null
  buckets: MeterReportBucket[]
  totalConsumption: number
}

export function getMeterReport(
  meterId: number,
  granularity: MeterReportGranularity = 'month',
  allocation: MeterReportAllocation = 'interpolated',
) {
  const q = new URLSearchParams({ granularity, allocation })
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
  /** Lowest coverage among the contributing meters, 0..1. */
  coverage: number
  gridImport: number | null
  gridExport: number | null
  production: number | null
  selfConsumption: number | null
  totalConsumption: number | null
  consumptionWithoutHeatPumpAndEv: number | null
  autarky: number | null
  selfConsumptionRate: number | null
  heatPumpTotal: number | null
  heatHeatingTotal: number | null
  heatHeatingPv: number | null
  heatHeatingGrid: number | null
  heatHeatingPvShare: number | null
  hotWaterTotal: number | null
  hotWaterPv: number | null
  hotWaterGrid: number | null
  hotWaterPvShare: number | null
  evChargerTotal: number | null
  evChargerPv: number | null
  evChargerGrid: number | null
  evChargerPvShare: number | null
  costs: EnergyTariffCosts | null
}

export interface EnergyTariffCosts {
  gridImportCostEur: number | null
  baseCostEur: number | null
  feedInRevenueEur: number | null
  avoidedGridCostEur: number | null
  pvBenefitEur: number | null
  netElectricityCostEur: number | null
  noPvElectricityCostEur: number | null
}

export interface EnergyReport {
  unit: string
  decimals: number
  granularity: MeterReportGranularity
  allocation: MeterReportAllocation
  from: string | null
  to: string | null
  meters: EnergyReportMeterRef[]
  missingRoles: EnergyReportRole[]
  buckets: EnergyReportBucket[]
  totals: Omit<EnergyReportBucket, 'key' | 'label' | 'periodStart' | 'periodEnd' | 'coverage'>
  hasTariffs: boolean
}

export function getEnergyReport(
  granularity: MeterReportGranularity = 'month',
  allocation: MeterReportAllocation = 'interpolated',
) {
  const q = new URLSearchParams({ granularity, allocation })
  return apiFetch<EnergyReport>(`/meters/reports/energy?${q}`)
}

// ── Consumption trends ─────────────────────────────────────────────────────

export type TrendDirection = 'rising' | 'falling' | 'stable' | 'unknown'

export interface TrendPoint {
  key: string
  label: string
  /** Consumption in that month; null if the month is not fully measured. */
  value: number | null
  /** That month plus the eleven before it; null if any of them is missing. */
  rolling12: number | null
}

export interface ConsumptionTrend {
  key: string
  label: string
  unit: string
  decimals: number
  meterIds: number[]
  /** Last twelve fully measured months. */
  current12: number | null
  /** The twelve months before those. */
  previous12: number | null
  changeAbsolute: number | null
  changePercent: number | null
  /** Change of the annual total per year, from a regression over rolling12. */
  slopePerYear: number | null
  direction: TrendDirection
  monthsAvailable: number
  rangeStart: string | null
  rangeEnd: string | null
  points: TrendPoint[]
}

export interface ConsumptionTrendsReport {
  generatedAt: string
  trends: ConsumptionTrend[]
}

export function getConsumptionTrends() {
  return apiFetch<ConsumptionTrendsReport>('/meters/reports/trends')
}

// ── PV economics / cost per application ────────────────────────────────────

export interface PvEconomicsBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  /** Electricity cost as it actually was, with the PV system. */
  netElectricityCostEur: number | null
  /** What the same consumption would have cost bought entirely from the grid. */
  noPvElectricityCostEur: number | null
  savingsEur: number | null
  pvBenefitEur: number | null
  cumulativeSavingsEur: number | null
  cumulativePvBenefitEur: number | null
}

export interface PvAmortization {
  investmentNetEur: number | null
  investmentVatEur: number | null
  investmentTotalEur: number | null
  opportunityCostPerYearEur: number | null
  cumulativePvBenefitEur: number
  remainingEur: number | null
  remainingWithOpportunityEur: number | null
  benefitLast12MonthsEur: number | null
  yearsElapsed: number
  payoffReached: boolean
  projectedPayoffDate: string | null
  projectedPayoffDateWithOpportunity: string | null
}

export interface ApplicationCost {
  totalKwh: number | null
  pvKwh: number | null
  gridKwh: number | null
  costEur: number | null
}

export interface UsageCostBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  heating: ApplicationCost
  hotWater: ApplicationCost
  evCharger: ApplicationCost
  household: ApplicationCost
  /** Standing charge, which belongs to no single application. */
  baseCostEur: number | null
  totalCostEur: number | null
}

export interface EconomicsReport {
  granularity: MeterReportGranularity
  currency: 'EUR'
  from: string | null
  to: string | null
  hasTariffs: boolean
  hasInvestmentData: boolean
  pv: {
    buckets: PvEconomicsBucket[]
    totalSavingsEur: number | null
    totalPvBenefitEur: number | null
    totalNetElectricityCostEur: number | null
    totalNoPvElectricityCostEur: number | null
    amortization: PvAmortization | null
  }
  usageCosts: {
    buckets: UsageCostBucket[]
    totals: Omit<UsageCostBucket, 'key' | 'label' | 'periodStart' | 'periodEnd'>
  }
}

export function getEconomicsReport(granularity: MeterReportGranularity = 'month') {
  const q = new URLSearchParams({ granularity })
  return apiFetch<EconomicsReport>(`/meters/reports/economics?${q}`)
}

// ── Electricity tariffs / prices ───────────────────────────────────────────

export type ElectricityTariffKind =
  | 'grid_import'
  | 'base_price'
  | 'feed_in'
  | 'self_consumption_value'
  | 'pv_investment_net'
  | 'pv_investment_vat'
  | 'opportunity_cost_year'
  | 'opportunity_cost_total'
  | 'amortization_years'

export type ElectricityTariffUnit = 'eur_per_kwh' | 'eur_per_month' | 'eur' | 'years'

export interface ElectricityTariff {
  id: number
  kind: ElectricityTariffKind
  validFrom: string
  amount: number
  unit: ElectricityTariffUnit
  taxStatus: string | null
  name: string | null
  capacityLimitKw: number | null
  source: Record<string, unknown> | null
}

export interface UpsertElectricityTariffRequest {
  kind: ElectricityTariffKind
  validFrom: string
  amount: number
  unit: ElectricityTariffUnit
  taxStatus?: string | null
  name?: string | null
  capacityLimitKw?: number | null
}

export function listElectricityTariffs() {
  return apiFetch<{ tariffs: ElectricityTariff[] }>('/meters/tariffs/electricity')
}

export function createElectricityTariff(req: UpsertElectricityTariffRequest) {
  return apiFetch<ElectricityTariff>('/meters/tariffs/electricity', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function updateElectricityTariff(id: number, req: UpsertElectricityTariffRequest) {
  return apiFetch<ElectricityTariff>(`/meters/tariffs/electricity/${id}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

export function deleteElectricityTariff(id: number) {
  return apiFetch<{ deleted: boolean }>(`/meters/tariffs/electricity/${id}`, {
    method: 'DELETE',
  })
}

export function importElectricityPrices() {
  return apiFetch<{ created: number; updated: number; total: number; alreadyImported: boolean }>(
    '/meters/import/electricity-prices',
    { method: 'POST' },
  )
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

/** Human-readable German labels for optional energy report roles. */
export const METER_ROLE_LABELS: Record<MeterRole, string> = {
  grid_import: 'Netzbezug',
  grid_export: 'Einspeisung',
  pv_production: 'PV-Produktion',
  heat_pump_total: 'Wärmepumpe gesamt',
  heat_heating_total: 'Heizung gesamt',
  heat_heating_pv: 'Heizung PV',
  hot_water_total: 'Warmwasser gesamt',
  hot_water_pv: 'Warmwasser PV',
  ev_charger_total: 'E-Auto/Wallbox gesamt',
  ev_charger_pv: 'E-Auto/Wallbox PV',
}

export const ELECTRICITY_TARIFF_KIND_LABELS: Record<ElectricityTariffKind, string> = {
  grid_import: 'Arbeitspreis Netzbezug',
  base_price: 'Grundpreis',
  feed_in: 'Einspeisevergütung',
  self_consumption_value: 'Eigenverbrauchswert',
  pv_investment_net: 'PV-Invest netto',
  pv_investment_vat: 'PV-MwSt.',
  opportunity_cost_year: 'Opportunitätskosten/Jahr',
  opportunity_cost_total: 'Opportunitätskosten gesamt',
  amortization_years: 'Amortisation',
}

export const ELECTRICITY_TARIFF_UNIT_LABELS: Record<ElectricityTariffUnit, string> = {
  eur_per_kwh: '€/kWh',
  eur_per_month: '€/Monat',
  eur: '€',
  years: 'Jahre',
}
