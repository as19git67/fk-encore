/** German labels of the business register's enums (Finanzen › Betriebe). */
import type { BusinessAssetKind, BusinessKind, BusinessTaxSection, ParcelUsage } from '../api/finance'

export const BUSINESS_KIND_OPTIONS: { value: BusinessKind; label: string }[] = [
  { value: 'landwirtschaft', label: 'Land- und Forstwirtschaft (verpachtet)' },
  { value: 'photovoltaik', label: 'Photovoltaik-Anlage' },
  { value: 'gewerbe', label: 'Gewerbebetrieb' },
  { value: 'vermietung', label: 'Vermietung und Verpachtung' },
]

export const TAX_SECTION_OPTIONS: { value: BusinessTaxSection; label: string }[] = [
  { value: 'anlage-l', label: 'Anlage L' },
  { value: 'anlage-g', label: 'Anlage G' },
  { value: 'anlage-v', label: 'Anlage V' },
]

export const ASSET_KIND_OPTIONS: { value: BusinessAssetKind; label: string; rate: number }[] = [
  { value: 'gebaeude', label: 'Gebäude', rate: 2 },
  { value: 'flaeche', label: 'Grund und Boden (keine AfA)', rate: 0 },
  { value: 'maschine', label: 'Maschine, Gerät', rate: 10 },
  { value: 'pv_anlage', label: 'PV-Anlage', rate: 5 },
  { value: 'sonstiges', label: 'Sonstiges', rate: 10 },
]

export const PARCEL_USAGE_OPTIONS: { value: ParcelUsage; label: string }[] = [
  { value: 'acker', label: 'Acker' },
  { value: 'gruenland', label: 'Grünland' },
  { value: 'wald', label: 'Wald' },
  { value: 'hof', label: 'Hof- und Gebäudefläche' },
  { value: 'sonstiges', label: 'Sonstiges' },
]

function labelOf<T extends string>(options: { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value
}

export const businessKindLabel = (v: BusinessKind) => labelOf(BUSINESS_KIND_OPTIONS, v)
export const taxSectionLabel = (v: BusinessTaxSection) => labelOf(TAX_SECTION_OPTIONS, v)
export const assetKindLabel = (v: BusinessAssetKind) => labelOf(ASSET_KIND_OPTIONS, v)
export const parcelUsageLabel = (v: ParcelUsage) => labelOf(PARCEL_USAGE_OPTIONS, v)
