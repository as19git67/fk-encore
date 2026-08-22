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
  | 'compressor_hours'

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
  /** Expected yearly return of the money, as a ratio (0.05 = 5 %). */
  expectedReturnRate: number | null
  /** Return forgone so far, compounded at that rate. */
  opportunityCostEur: number | null
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
  /** One entry per visible water meter; empty without water tariffs. */
  water: WaterCostReport[]
}

export interface WaterCostBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  volume: number
  waterCostEur: number | null
  sewageCostEur: number | null
  baseCostEur: number | null
  totalCostEur: number | null
}

export interface WaterCostReport {
  meterId: number
  name: string
  unit: string
  buckets: WaterCostBucket[]
  totalVolume: number
  totalCostEur: number | null
}

export function getEconomicsReport(granularity: MeterReportGranularity = 'month') {
  const q = new URLSearchParams({ granularity })
  return apiFetch<EconomicsReport>(`/meters/reports/economics?${q}`)
}

// ── Technology comparisons (gas heating / petrol car) ──────────────────────

export interface ComparisonAssumption {
  kind: ElectricityTariffKind
  label: string
  amount: number
  unit: ElectricityTariffUnit
}

/** A figure with the range the SCOP uncertainty spans. */
export interface CostRange {
  low: number | null
  mid: number | null
  high: number | null
}

export interface HeatingComparisonBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  heatPumpKwh: number | null
  heatPumpCostEur: number | null
  heatDeliveredKwh: CostRange
  gasKwh: CostRange
  gasCostEur: CostRange
  /** Positive = the heat pump was cheaper. */
  savingsEur: CostRange
}

export interface HeatingComparison {
  buckets: HeatingComparisonBucket[]
  /** Span actually covered by buckets with heat pump consumption; null if none. */
  periodStart: string | null
  periodEnd: string | null
  totalHeatPumpCostEur: number | null
  totalGasCostEur: CostRange
  totalSavingsEur: CostRange
  avoidedCo2Kg: number | null
  scop: number | null
  scopRange: { low: number; high: number } | null
  assumptions: ComparisonAssumption[]
}

export interface CarComparisonBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  chargedKwh: number | null
  /** Actual metered cost of that charging electricity. */
  evCostEur: number | null
  /** Feed-in revenue forgone on the PV share of the charge; null without a feed-in tariff. */
  lostFeedInEur: number | null
  /** evCostEur plus the forgone feed-in revenue — the true cost of charging at home. */
  evCostWithOpportunityEur: number | null
  kilometers: number | null
  petrolLitres: number | null
  petrolCostEur: number | null
  savingsEur: number | null
}

export interface CarComparison {
  buckets: CarComparisonBucket[]
  /** Span actually covered by buckets with charging activity; null if none. */
  periodStart: string | null
  periodEnd: string | null
  totalChargedKwh: number | null
  totalKilometers: number | null
  totalEvCostEur: number | null
  totalLostFeedInEur: number | null
  totalEvCostWithOpportunityEur: number | null
  totalPetrolCostEur: number | null
  totalSavingsEur: number | null
  evCentsPerKm: number | null
  petrolCentsPerKm: number | null
  avoidedCo2Kg: number | null
  assumptions: ComparisonAssumption[]
}

export interface ComparisonsReport {
  granularity: MeterReportGranularity
  currency: 'EUR'
  from: string | null
  to: string | null
  hasHeatingAssumptions: boolean
  hasCarAssumptions: boolean
  heating: HeatingComparison | null
  car: CarComparison | null
}

export function getComparisonsReport(granularity: MeterReportGranularity = 'month') {
  const q = new URLSearchParams({ granularity })
  return apiFetch<ComparisonsReport>(`/meters/reports/comparisons?${q}`)
}

// ── Equipment condition ────────────────────────────────────────────────────

export interface OperatingHoursBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  hours: number
  /** Share of the measured time the machine actually ran, 0..1. */
  runtimeShare: number | null
  coverage: number
}

export interface OperatingHoursMetric {
  meterId: number
  name: string
  unit: string
  buckets: OperatingHoursBucket[]
  totalHours: number
  averageRuntimeShare: number | null
}

export interface CompressorEfficiencyBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  electricityKwh: number | null
  compressorHours: number | null
  /** Electricity per hour of running — rising means losing efficiency. */
  kwhPerHour: number | null
}

export interface CompressorEfficiency {
  electricityMeterId: number
  hoursMeterId: number
  buckets: CompressorEfficiencyBucket[]
  earliestKwhPerHour: number | null
  latestKwhPerHour: number | null
  changePercent: number | null
  slopePerYear: number | null
}

export interface WaterBaselineBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  /** Lowest daily rate among the reading intervals starting in this period. */
  minDailyRate: number | null
  averageDailyRate: number | null
  intervals: number
}

export interface WaterBaseline {
  meterId: number
  name: string
  unit: string
  buckets: WaterBaselineBucket[]
  latestMinDailyRate: number | null
  previousYearMinDailyRate: number | null
  changePercent: number | null
  slopePerYear: number | null
}

export interface PvYieldBucket {
  key: string
  label: string
  periodStart: string
  periodEnd: string
  productionKwh: number
  yieldPerKwp: number | null
  coverage: number
}

export interface PvYieldReport {
  meterId: number
  capacityKwp: number
  buckets: PvYieldBucket[]
  bestYieldPerKwp: number | null
  latestYieldPerKwp: number | null
  changeVsBestPercent: number | null
}

export interface EquipmentReport {
  granularity: MeterReportGranularity
  from: string | null
  to: string | null
  operatingHours: OperatingHoursMetric[]
  compressorEfficiency: CompressorEfficiency | null
  waterBaselines: WaterBaseline[]
  pvYield: PvYieldReport | null
}

export function getEquipmentReport(granularity: MeterReportGranularity = 'month') {
  const q = new URLSearchParams({ granularity })
  return apiFetch<EquipmentReport>(`/meters/reports/equipment?${q}`)
}

// ── Electricity tariffs / prices ───────────────────────────────────────────

export type ElectricityTariffKind =
  | 'grid_import'
  | 'base_price'
  | 'feed_in'
  | 'self_consumption_value'
  | 'pv_investment_net'
  | 'pv_investment_vat'
  | 'expected_return_rate'
  // Assumptions for the gas-heating / petrol-car comparisons.
  | 'gas_price'
  | 'gas_base_price'
  | 'boiler_efficiency'
  | 'heat_pump_scop'
  | 'ev_consumption'
  | 'petrol_consumption'
  | 'petrol_price'
  | 'grid_co2'
  | 'gas_co2'
  | 'petrol_co2'
  | 'pv_capacity_kwp'
  | 'water_price'
  | 'water_base_price'
  | 'sewage_price'

export type ElectricityTariffUnit =
  | 'eur_per_kwh'
  | 'eur_per_month'
  | 'eur'
  | 'ratio'
  | 'kwh_per_100km'
  | 'l_per_100km'
  | 'eur_per_l'
  | 'kg_per_kwh'
  | 'kg_per_l'
  | 'kw'
  | 'eur_per_m3'

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

/** One row of a tariff/assumption import file. */
export interface TariffImportEntry {
  kind: string
  validFrom: string
  amount: number
  unit: string
  taxStatus?: string | null
  name?: string | null
  capacityLimitKw?: number | null
  source?: Record<string, unknown> | null
}

export interface TariffImportResult {
  created: number
  updated: number
  failed: number
  errors: Array<{ index: number; message: string }>
}

export function importTariffFile(entries: TariffImportEntry[]) {
  return apiFetch<TariffImportResult>('/meters/tariffs/import', {
    method: 'POST',
    body: JSON.stringify({ entries }),
  })
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
  compressor_hours: 'Verdichter-Betriebsstunden',
}

export const ELECTRICITY_TARIFF_KIND_LABELS: Record<ElectricityTariffKind, string> = {
  grid_import: 'Arbeitspreis Netzbezug',
  base_price: 'Grundpreis',
  feed_in: 'Einspeisevergütung',
  self_consumption_value: 'Eigenverbrauchswert',
  pv_investment_net: 'PV-Invest netto',
  pv_investment_vat: 'PV-MwSt.',
  expected_return_rate: 'Erwartete Rendite/Jahr',
  gas_price: 'Gaspreis',
  gas_base_price: 'Gas-Grundpreis',
  boiler_efficiency: 'Kesselwirkungsgrad',
  heat_pump_scop: 'Jahresarbeitszahl (JAZ)',
  ev_consumption: 'Verbrauch E-Auto',
  petrol_consumption: 'Verbrauch Benziner',
  petrol_price: 'Benzinpreis',
  grid_co2: 'CO₂-Faktor Netzstrom',
  gas_co2: 'CO₂-Faktor Erdgas',
  petrol_co2: 'CO₂-Faktor Benzin',
  pv_capacity_kwp: 'PV-Anlagenleistung',
  water_price: 'Wasserpreis',
  water_base_price: 'Wasser-Grundgebühr',
  sewage_price: 'Abwasserpreis',
}

/** Plain-language explanation of what the value means, shown under the tariff form. */
export const ELECTRICITY_TARIFF_KIND_EXPLANATIONS: Record<ElectricityTariffKind, string> = {
  grid_import: 'Was du pro kWh für Strom aus dem Netz zahlst.',
  base_price: 'Monatliche Grundgebühr des Stromlieferanten, unabhängig vom Verbrauch.',
  feed_in: 'Was du pro eingespeister kWh vom Netzbetreiber vergütet bekommst.',
  self_consumption_value:
    'Was dir eine selbst verbrauchte PV-kWh wert ist — üblicherweise dein Arbeitspreis Netzbezug, weil genau den sparst du dir.',
  pv_investment_net: 'Anschaffungskosten der PV-Anlage ohne Mehrwertsteuer.',
  pv_investment_vat: 'Mehrwertsteuer auf die Anschaffungskosten der PV-Anlage.',
  expected_return_rate:
    'Rendite pro Jahr, die das investierte Geld anderswo erwartungsgemäß gebracht hätte (z. B. 0,05 für 5 %). Daraus werden die Opportunitätskosten der Amortisation berechnet.',
  gas_price: 'Gas-Arbeitspreis pro kWh, für den Vergleich mit einer Gasheizung.',
  gas_base_price: 'Monatliche Grundgebühr eines Gasanschlusses, für den Vergleich mit einer Gasheizung.',
  boiler_efficiency:
    'Wirkungsgrad eines Gaskessels (0..1): wie viel der eingesetzten Gasenergie tatsächlich als Wärme ankommt. Ein moderner Brennwertkessel liegt nahe 1.',
  heat_pump_scop:
    'Jahresarbeitszahl (JAZ/SCOP) der Wärmepumpe: wie viel kWh Wärme sie im Schnitt aus 1 kWh Strom macht. Ohne Wärmemengenzähler eine Schätzung — der Report zeigt deshalb eine Bandbreite.',
  ev_consumption: 'Stromverbrauch des E-Autos in kWh je 100 km.',
  petrol_consumption: 'Verbrauch eines vergleichbaren Benziners in Liter je 100 km.',
  petrol_price: 'Benzinpreis pro Liter, für den Vergleich mit einem Verbrenner.',
  grid_co2: 'CO₂-Ausstoß pro kWh Netzstrom (Strommix), für die CO₂-Bilanz.',
  gas_co2: 'CO₂-Ausstoß pro kWh verbranntes Erdgas, für die CO₂-Bilanz.',
  petrol_co2: 'CO₂-Ausstoß pro Liter verbranntes Benzin, für die CO₂-Bilanz.',
  pv_capacity_kwp: 'Installierte Anlagenleistung der PV-Anlage in kWp, für den Ertrag je kWp.',
  water_price: 'Frischwasserpreis pro m³.',
  water_base_price: 'Monatliche Grundgebühr des Wasseranschlusses.',
  sewage_price:
    'Abwasserpreis pro m³ — wird meist auf dieselbe gemessene Wassermenge berechnet wie der Frischwasserpreis.',
}

export const ELECTRICITY_TARIFF_UNIT_LABELS: Record<ElectricityTariffUnit, string> = {
  eur_per_kwh: '€/kWh',
  eur_per_month: '€/Monat',
  eur: '€',
  ratio: 'Faktor',
  kwh_per_100km: 'kWh/100 km',
  l_per_100km: 'l/100 km',
  eur_per_l: '€/l',
  kg_per_kwh: 'kg CO₂/kWh',
  kg_per_l: 'kg CO₂/l',
  kw: 'kWp',
  eur_per_m3: '€/m³',
}
